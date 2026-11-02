/** Ablauflogik: automatische Läufe sowie Vorschau/Veröffentlichen/Überspringen aus dem Dashboard. */

import type { Config } from "./config.ts";
import type { LogKind, Store } from "./db.ts";
import { DONE_FLAG, SKIPPED_FLAG, looksRelevant, type PressMail } from "./mail.ts";
import { cleanArticle, type Article } from "./rewrite.ts";

/** Schnittstellen statt Klassen, damit die Tests Fakes einsetzen können. */
export interface Deps {
  mailbox: {
    candidates(): Promise<PressMail[]>;
    get(uid: number): Promise<PressMail | null>;
    mark(uid: number, flag: typeof DONE_FLAG | typeof SKIPPED_FLAG): Promise<void>;
  };
  wordpress: {
    postsToday(): Promise<number>;
    slugExists(slug: string): Promise<boolean>;
    createPost(article: Article, image?: PressMail["images"][number]): Promise<{ id: number; link: string }>;
  };
  rewriter: { rewrite(mail: PressMail): Promise<Article> };
  store: Store;
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
  busy = false;

  constructor(private cfg: Config, private deps: Deps) {}

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

  private log(kind: LogKind, subject = "", detail = "", link = "") {
    this.deps.store.log(kind, subject, detail, link);
  }

  async remainingToday(): Promise<{ today: number; limit: number }> {
    return { today: await this.deps.wordpress.postsToday(), limit: this.cfg.limits.daily };
  }

  async listMails(): Promise<MailSummary[]> {
    const drafts = this.deps.store.draftUids();
    return (await this.deps.mailbox.candidates()).map((m) => ({
      uid: m.uid,
      subject: m.subject,
      sender: m.sender,
      date: m.date,
      snippet: m.body.slice(0, 280),
      images: m.images.length,
      prefilter: looksRelevant(m),
      hasDraft: drafts.has(m.uid),
    }));
  }

  /** Entwurf aus dem Cache oder frisch von Claude. */
  private async draftFor(mail: PressMail, refresh = false): Promise<Article> {
    const cached = refresh ? null : this.deps.store.getDraft(mail.uid);
    if (cached) return cached;
    const article = await this.deps.rewriter.rewrite(mail);
    this.deps.store.saveDraft(mail.uid, article);
    return article;
  }

  private async mustGet(uid: number): Promise<PressMail> {
    const mail = await this.deps.mailbox.get(uid);
    if (!mail) throw new Error(`Mail ${uid} nicht gefunden`);
    return mail;
  }

  preview(uid: number, refresh = false): Promise<Article> {
    return this.exclusive(async () => this.draftFor(await this.mustGet(uid), refresh));
  }

  saveDraft(uid: number, article: Article): Article {
    const cleaned = cleanArticle({ ...article, relevant: true }, this.cfg.wp.categories);
    this.deps.store.saveDraft(uid, cleaned);
    return cleaned;
  }

  skip(uid: number): Promise<void> {
    return this.exclusive(async () => {
      const mail = await this.mustGet(uid);
      await this.deps.mailbox.mark(uid, SKIPPED_FLAG);
      this.deps.store.deleteDraft(uid);
      this.log("skipped", mail.subject, "manuell übersprungen");
    });
  }

  private async publishMail(mail: PressMail, article: Article): Promise<{ id: number; link: string }> {
    const image = this.cfg.wp.featuredImage ? mail.images[0] : undefined;
    const post = await this.deps.wordpress.createPost(article, image);
    await this.deps.mailbox.mark(mail.uid, DONE_FLAG);
    this.deps.store.deleteDraft(mail.uid);
    this.log("published", article.title, mail.subject, post.link);
    return post;
  }

  /** Manuell aus dem Dashboard veröffentlichen – das Tageslimit gilt auch hier. */
  publish(uid: number): Promise<{ id: number; link: string }> {
    return this.exclusive(async () => {
      const { today, limit } = await this.remainingToday();
      if (today >= limit) throw new Error(`Tageslimit erreicht (${today}/${limit})`);
      const mail = await this.mustGet(uid);
      const article = await this.draftFor(mail);
      if (!article.relevant) throw new Error(`Claude hält die Mail nicht für relevant: ${article.reason}`);
      if (await this.deps.wordpress.slugExists(article.slug)) throw new Error(`Slug „${article.slug}“ existiert bereits`);
      return this.publishMail(mail, article);
    });
  }

  /** Automatischer Lauf: höchstens POSTS_PER_RUN neue Beiträge, nie über DAILY_LIMIT. */
  run(dryRun = false): Promise<RunResult> {
    return this.exclusive(async () => {
      const result: RunResult = { published: [], skipped: 0, dryRun, previews: [], message: "" };
      try {
        const { today, limit } = await this.remainingToday();
        const remaining = Math.min(this.cfg.limits.perRun, limit - today);
        if (remaining <= 0) {
          result.message = `Tageslimit erreicht (${today}/${limit})`;
          return result;
        }

        for (const mail of await this.deps.mailbox.candidates()) {
          if (result.published.length + result.previews.length >= remaining) break;

          if (!looksRelevant(mail)) {
            result.skipped++;
            if (!dryRun) {
              await this.deps.mailbox.mark(mail.uid, SKIPPED_FLAG);
              this.log("skipped", mail.subject, "Vorfilter: keine Musik-Stichworte");
            }
            continue;
          }

          const article = await this.draftFor(mail);
          if (!article.relevant) {
            result.skipped++;
            if (!dryRun) {
              await this.deps.mailbox.mark(mail.uid, SKIPPED_FLAG);
              this.deps.store.deleteDraft(mail.uid);
              this.log("skipped", mail.subject, `nicht relevant: ${article.reason}`);
            }
            continue;
          }

          if (await this.deps.wordpress.slugExists(article.slug)) {
            result.skipped++;
            if (!dryRun) {
              await this.deps.mailbox.mark(mail.uid, DONE_FLAG);
              this.deps.store.deleteDraft(mail.uid);
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
        this.log("error", "", String(err));
        throw err;
      } finally {
        if (!dryRun && result.message) this.log("run", "", result.message);
      }
    });
  }
}
