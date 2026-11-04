/** Ablauflogik: automatische Läufe sowie Vorschau/Veröffentlichen/Überspringen aus dem Dashboard. */

import type { Config } from "./config.ts";
import type { LogKind, Store } from "./db.ts";
import { fingerprint, groupDuplicates, isDuplicate } from "./duplicates.ts";
import type { ImageInfo, MailImages, VideoInfo } from "./images.ts";
import { originalMail, renderMailHtml, type OriginalMail } from "./mail-view.ts";
import { DONE_FLAG, SKIPPED_FLAG, looksRelevant, type ImageAttachment, type MailboxStatus, type PressMail } from "./mail.ts";
import { CancelledError, cleanArticle, type Article } from "./rewrite.ts";
import type { WpCategory } from "./wordpress.ts";

/** Schnittstellen statt Klassen, damit die Tests Fakes einsetzen können. */
export interface Deps {
  mailbox: {
    candidates(done?: Set<string>): Promise<PressMail[]>;
    get(uid: number): Promise<PressMail | null>;
    mark(uid: number, flag: typeof DONE_FLAG | typeof SKIPPED_FLAG): Promise<void>;
    status?(): MailboxStatus[];
  };
  wordpress: {
    postsToday(): Promise<number>;
    slugExists(slug: string): Promise<boolean>;
    /** Kategorien der Website fürs Dashboard (fehlt in der Demo) */
    categories?(): Promise<WpCategory[]>;
    createPost(
      article: Article, featured?: ImageAttachment, inline?: ImageAttachment[], videos?: { video: VideoInfo; thumbnail: ImageAttachment | null }[],
    ): Promise<{ id: number; link: string }>;
  };
  rewriter: { rewrite(mail: PressMail): Promise<Article>; cancel?(): boolean };
  images: {
    collect(mail: PressMail): Promise<MailImages>;
    read(mail: Pick<PressMail, "messageId">, id: string): Promise<(ImageInfo & { data: Buffer }) | null>;
    videoThumbnail(video: VideoInfo): Promise<ImageAttachment | null>;
  };
  notifier?: { notify(n: { title: string; body: string; url: string; tag: string }): Promise<void> };
  store: Store;
}

/** Höchstens so viele Mails prüft ein Vorschlags-Lauf, bevor er aufgibt (lokale Modelle sind langsam). */
const MAX_SUGGEST_ATTEMPTS = 5;
/** So lange merkt sich das Tool erledigte Mails, um spätere Dubletten aus anderen Postfächern zu erkennen. */
const FINGERPRINT_DAYS = 30;

export interface DuplicateInfo {
  uid: number;
  account: string;
  sender: string;
  subject: string;
  date: string;
}

export interface MailSummary {
  uid: number;
  subject: string;
  sender: string;
  date: string;
  snippet: string;
  images: number;
  prefilter: boolean;
  hasDraft: boolean;
  account: string;
  /** dieselbe Mail aus anderen Postfächern (oder doppelt im selben) */
  duplicates: DuplicateInfo[];
}

export interface SuggestResult {
  suggested: { uid: number; title: string } | null;
  skipped: number;
  message: string;
}

export interface RunResult {
  published: { title: string; link: string }[];
  skipped: number;
  dryRun: boolean;
  previews: Article[];
  message: string;
}

export class Pipeline {
  private queue: Promise<unknown> = Promise.resolve();
  /** UID → Message-ID, damit Bildanfragen nicht jedes Mal das Postfach abfragen müssen */
  private keys = new Map<number, string>();
  /** Hauptmail → ihre Dubletten aus dem letzten Abruf; werden beim Erledigen mit markiert */
  private dupes = new Map<number, PressMail[]>();
  busy = false;

  constructor(private cfg: Config, private deps: Deps) {}

  /** Laufende Generierung abbrechen (Knopf im Dashboard); false, wenn gerade nichts geschrieben wird. */
  cancel(): boolean {
    return this.deps.rewriter.cancel?.() ?? false;
  }

  /** Alle Aktionen nacheinander ausführen – Zeitplan und Dashboard dürfen sich nicht überholen. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Mail samt Dubletten als erledigt merken: IMAP-Markierung (falls möglich) und lokale Datenbank. */
  private async markMail(mail: PressMail, flag: typeof DONE_FLAG | typeof SKIPPED_FLAG) {
    for (const m of [mail, ...(this.dupes.get(mail.uid) ?? [])]) {
      this.deps.store.markProcessed(m.messageId, flag === DONE_FLAG ? "done" : "skipped");
      this.deps.store.saveFingerprint(fingerprint(m), m.subject);
      this.deps.store.deleteDraft(m.uid);
      await this.deps.mailbox.mark(m.uid, flag);
    }
    this.dupes.delete(mail.uid);
  }

  private log(kind: LogKind, subject = "", detail = "", link = "") {
    this.deps.store.log(kind, subject, detail, link);
  }

  async remainingToday(): Promise<{ today: number; limit: number }> {
    return { today: await this.deps.wordpress.postsToday(), limit: this.cfg.limits.daily };
  }

  mailboxStatus(): MailboxStatus[] {
    return this.deps.mailbox.status?.() ?? [];
  }

  /**
   * Offene Mails aller Postfächer, Dubletten zusammengefasst (nur die Hauptmail kommt zurück).
   * Mails, die einer bereits erledigten gleichen, werden gleich mit erledigt.
   */
  private async candidates(): Promise<PressMail[]> {
    const mails = await this.deps.mailbox.candidates(this.deps.store.processedIds());
    for (const m of mails) this.keys.set(m.uid, m.messageId);

    const handled = this.deps.store.fingerprints(FINGERPRINT_DAYS);
    const open: PressMail[] = [];
    for (const mail of mails) {
      const print = fingerprint(mail);
      const earlier = handled.find((h) => isDuplicate(print, h));
      if (!earlier) {
        open.push(mail);
        continue;
      }
      this.deps.store.markProcessed(mail.messageId, "skipped");
      this.deps.store.deleteDraft(mail.uid);
      await this.deps.mailbox.mark(mail.uid, SKIPPED_FLAG);
      this.log("skipped", mail.subject, `Dublette${mail.account ? ` aus ${mail.account}` : ""} – schon bearbeitet: „${earlier.subject}“`);
    }

    const drafts = this.deps.store.draftUids();
    const groups = groupDuplicates(open, (m) => drafts.has(m.uid));
    this.dupes = new Map(groups.filter((g) => g.duplicates.length).map((g) => [g.mail.uid, g.duplicates]));
    return groups.map((g) => g.mail);
  }

  async listMails(): Promise<MailSummary[]> {
    const drafts = this.deps.store.draftUids();
    return (await this.candidates()).map((m) => ({
      uid: m.uid,
      subject: m.subject,
      sender: m.sender,
      date: m.date,
      snippet: m.body.slice(0, 280),
      images: m.images.length + (m.imageUrls?.length ?? 0),
      prefilter: looksRelevant(m),
      hasDraft: drafts.has(m.uid),
      account: m.account ?? "",
      duplicates: (this.dupes.get(m.uid) ?? []).map((d) => ({ uid: d.uid, account: d.account ?? "", sender: d.sender, subject: d.subject, date: d.date })),
    }));
  }

  /** Entwurf aus dem Cache oder frisch von Claude. */
  private async draftFor(mail: PressMail, refresh = false): Promise<Article> {
    const cached = refresh ? null : this.deps.store.getDraft(mail.uid);
    // Regeln (Link-Filter, nicht gendern …) auch auf ältere Entwürfe anwenden
    if (cached) return cleanArticle(cached, this.cfg.wp.categories);
    const article = await this.deps.rewriter.rewrite(mail);
    this.deps.store.saveDraft(mail.uid, article);
    return article;
  }

  private async mustGet(uid: number): Promise<PressMail> {
    const mail = await this.deps.mailbox.get(uid);
    if (!mail) throw new Error(`Mail ${uid} nicht gefunden`);
    this.keys.set(uid, mail.messageId);
    return mail;
  }

  /** Bilder einer Mail fürs Dashboard (beim ersten Mal werden verlinkte Bilder geladen). */
  async images(uid: number): Promise<MailImages> {
    return this.deps.images.collect(await this.mustGet(uid));
  }

  async image(uid: number, id: string): Promise<(ImageInfo & { data: Buffer }) | null> {
    const messageId = this.keys.get(uid) ?? (await this.mustGet(uid)).messageId;
    return this.deps.images.read({ messageId }, id);
  }

  /** Videos laut Entwurf (Standard: erstes Video der Mail) samt Vorschaubild für die cookiefreie Einbindung. */
  private async pickVideos(mail: PressMail, article: Article) {
    const { videos } = await this.deps.images.collect(mail);
    const ids = article.videos ?? videos.slice(0, 1).map((v) => v.id);
    const chosen = ids.map((id) => videos.find((v) => v.id === id)).filter((v): v is VideoInfo => !!v);
    return Promise.all(chosen.map(async (video) => ({ video, thumbnail: await this.deps.images.videoThumbnail(video) })));
  }

  /** Beitragsbild und Bilder im Text gemäß Auswahl im Entwurf (Standard: größtes Bild als Thumbnail). */
  private async pickImages(mail: PressMail, article: Article): Promise<{ featured?: ImageAttachment; inline: ImageAttachment[] }> {
    const { images } = await this.deps.images.collect(mail);
    const auto = this.cfg.wp.featuredImage ? images[0]?.id : undefined;
    const featuredId = article.featured_image === "none" ? undefined : article.featured_image || auto;
    const load = async (id: string) => {
      const img = await this.deps.images.read(mail, id);
      return img ? { filename: img.filename, contentType: img.contentType, data: img.data } : undefined;
    };
    const featured = featuredId ? await load(featuredId) : undefined;
    const inline = (await Promise.all(article.inline_images.map(load))).filter((i): i is ImageAttachment => !!i);
    return { featured, inline };
  }

  /** Vollständige Original-Mail für die Vergleichsansicht im Dashboard. */
  async original(uid: number): Promise<OriginalMail> {
    return originalMail(await this.mustGet(uid));
  }

  /** Mail-HTML für die formatierte Ansicht (null bei reinen Text-Mails). */
  async originalHtml(uid: number, remoteImages = false): Promise<string | null> {
    const mail = await this.mustGet(uid);
    return mail.html ? renderMailHtml(mail, remoteImages) : null;
  }

  preview(uid: number, refresh = false): Promise<Article> {
    return this.exclusive(async () => this.draftFor(await this.mustGet(uid), refresh));
  }

  /** Kategorien aus WordPress samt Zuordnung der Modell-Kategorien (WP_CATEGORIES) zu ihren Slugs */
  async categories(): Promise<{ categories: WpCategory[]; defaults: Record<string, string> }> {
    const categories = (await this.deps.wordpress.categories?.()) ?? [];
    return { categories, defaults: this.cfg.wp.categorySlugs };
  }

  saveDraft(uid: number, article: Article): Article {
    const cleaned = cleanArticle({ ...article, relevant: true }, this.cfg.wp.categories);
    this.deps.store.saveDraft(uid, cleaned);
    return cleaned;
  }

  skip(uid: number): Promise<void> {
    return this.exclusive(async () => {
      const mail = await this.mustGet(uid);
      await this.markMail(mail, SKIPPED_FLAG);
      this.log("skipped", mail.subject, "manuell übersprungen");
    });
  }

  private async publishMail(mail: PressMail, draft: Article): Promise<{ id: number; link: string }> {
    // Regeln (z. B. „nicht gendern“) auch auf ältere oder von Hand bearbeitete Entwürfe anwenden
    const article = cleanArticle(draft, this.cfg.wp.categories);
    const { featured, inline } = await this.pickImages(mail, article);
    const post = await this.deps.wordpress.createPost(article, featured, inline, await this.pickVideos(mail, article));
    await this.markMail(mail, DONE_FLAG);
    this.log("published", article.title, mail.subject, post.link);
    return post;
  }

  /** Manuell aus dem Dashboard veröffentlichen – DAILY_LIMIT ist nur ein Richtwert und bremst hier nicht. */
  publish(uid: number): Promise<{ id: number; link: string }> {
    return this.exclusive(async () => {
      const mail = await this.mustGet(uid);
      const article = await this.draftFor(mail);
      if (!article.relevant) throw new Error(`Claude hält die Mail nicht für relevant: ${article.reason}`);
      if (await this.deps.wordpress.slugExists(article.slug)) throw new Error(`Slug „${article.slug}“ existiert bereits`);
      return this.publishMail(mail, article);
    });
  }

  /**
   * Automatischer Vorschlag: nächste Musik-Mail ohne Entwurf umschreiben, Bilder vorladen und
   * per Push benachrichtigen. Veröffentlicht nichts.
   */
  suggest(): Promise<SuggestResult> {
    return this.exclusive(async () => {
      const result: SuggestResult = { suggested: null, skipped: 0, message: "" };
      const drafts = this.deps.store.draftUids();
      const open = (await this.candidates()).filter((m) => !drafts.has(m.uid) && looksRelevant(m));

      for (const mail of open.slice(0, MAX_SUGGEST_ATTEMPTS)) {
        const article = await this.draftFor(mail);
        if (!article.relevant) {
          result.skipped++;
          await this.markMail(mail, SKIPPED_FLAG);
          this.log("skipped", mail.subject, `nicht relevant: ${article.reason}`);
          continue;
        }
        const { images } = await this.deps.images.collect(mail);
        result.suggested = { uid: mail.uid, title: article.title };
        this.log("suggested", article.title, `${mail.subject} · ${images.length} Bild${images.length === 1 ? "" : "er"}`);
        await this.deps.notifier?.notify({
          title: "Neuer Vorschlag",
          body: article.title,
          url: `/?mail=${mail.uid}`,
          tag: `vorschlag-${mail.uid}`,
        }).catch((err) => this.log("error", "", `Benachrichtigung fehlgeschlagen: ${err}`));
        break;
      }

      result.message = result.suggested
        ? `Vorschlag erstellt: ${result.suggested.title}`
        : open.length ? `Kein passender Vorschlag unter ${Math.min(open.length, MAX_SUGGEST_ATTEMPTS)} Mails` : "Keine offenen Musik-Mails";
      return result;
    });
  }

  /**
   * Lauf: höchstens POSTS_PER_RUN neue Beiträge. Der Zeitplan hält sich an den Richtwert DAILY_LIMIT,
   * ein manueller Klick („Ausführen“) darf darüber hinaus.
   */
  run(dryRun = false, { manual = false } = {}): Promise<RunResult> {
    return this.exclusive(async () => {
      const result: RunResult = { published: [], skipped: 0, dryRun, previews: [], message: "" };
      try {
        const { today, limit } = await this.remainingToday();
        const remaining = manual ? this.cfg.limits.perRun : Math.min(this.cfg.limits.perRun, limit - today);
        if (remaining <= 0) {
          result.message = `Richtwert für heute erreicht (${today}/${limit}) – manuell geht weiterhin`;
          return result;
        }

        for (const mail of await this.candidates()) {
          if (result.published.length + result.previews.length >= remaining) break;

          if (!looksRelevant(mail)) {
            result.skipped++;
            if (!dryRun) {
              await this.markMail(mail, SKIPPED_FLAG);
              this.log("skipped", mail.subject, "Vorfilter: keine Musik-Stichworte");
            }
            continue;
          }

          const article = await this.draftFor(mail);
          if (!article.relevant) {
            result.skipped++;
            if (!dryRun) {
              await this.markMail(mail, SKIPPED_FLAG);
              this.log("skipped", mail.subject, `nicht relevant: ${article.reason}`);
            }
            continue;
          }

          if (await this.deps.wordpress.slugExists(article.slug)) {
            result.skipped++;
            if (!dryRun) {
              await this.markMail(mail, DONE_FLAG);
              this.log("skipped", mail.subject, `Beitrag existiert bereits (${article.slug})`);
            }
            continue;
          }

          if (dryRun) {
            result.previews.push(article);
            continue;
          }
          const post = await this.publishMail(mail, article);
          result.published.push({ title: article.title, link: post.link });
        }

        const count = dryRun ? result.previews.length : result.published.length;
        result.message = `${count} Beitrag/Beiträge ${dryRun ? "als Vorschau erzeugt" : "veröffentlicht"}, ${result.skipped} übersprungen`;
        return result;
      } catch (err) {
        // abgebrochen ist kein Fehler – die Mail bleibt unbearbeitet und kommt beim nächsten Lauf wieder
        if (err instanceof CancelledError) result.message = "Lauf abgebrochen";
        else this.log("error", "", String(err));
        throw err;
      } finally {
        if (!dryRun && result.message) this.log("run", "", result.message);
      }
    });
  }
}
