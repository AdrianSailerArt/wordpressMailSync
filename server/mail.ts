/** IMAP: Kandidaten-Mails holen, parsen und als erledigt markieren. */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import type { Config } from "./config.ts";

export const DONE_FLAG = "$PressbotDone";
export const SKIPPED_FLAG = "$PressbotSkipped";

/** Grober Vorfilter, damit nicht jede Newsletter-Mail an Claude geht. */
const KEYWORDS =
  /tour|konzert|concert|live|festival|tickets?|album|single|\bep\b|release|veröffentlich|pressemitteilung|pressemeldung|press release|presseinfo|video|premiere|ankündig|announce|show|open\s?air/i;

const MAX_BODY_CHARS = 40_000;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export interface ImageAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
  /** im HTML eingebettet (cid:) statt als echter Anhang */
  inline?: boolean;
  /** Content-ID, über die das HTML das Bild als cid: einbindet */
  cid?: string;
}

export interface PressMail {
  uid: number;
  /** Message-ID-Header – bleibt auch beim Verschieben gleich und dient als Schlüssel in der Datenbank */
  messageId: string;
  subject: string;
  sender: string;
  date: string;
  body: string;
  /** Empfänger (An) */
  to?: string;
  /** Original-HTML der Mail, für die Anzeige im Dashboard */
  html?: string;
  /** Alle Anhänge (nur Name, Typ, Größe) */
  attachments?: { filename: string; contentType: string; size: number }[];
  /** Bild-Anhänge und eingebettete Bilder (ungefiltert – Logos sortiert images.ts aus) */
  images: ImageAttachment[];
  /** Im HTML verlinkte Bilder (<img src>, Links auf .jpg/.png/.webp) */
  imageUrls?: string[];
  /** Links, hinter denen vermutlich Pressefotos liegen (WeTransfer, Dropbox, „Pressefotos“ …) */
  downloadLinks?: { url: string; label: string }[];
  /** YouTube-Video-IDs aus Links und eingebetteten Playern */
  videoIds?: string[];
  /** Links, die nach Video aussehen, aber hinter einem Klick-Zähler stecken (CleverReach, Mailchimp …) */
  videoLinks?: string[];
}

/** YouTube-Video-ID aus allen üblichen Link-Formen; Kanäle, Playlists ohne Video usw. ergeben null. */
export function youtubeId(url: string): string | null {
  const m = url.match(/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i);
  return m ? m[1]! : null;
}

export const looksRelevant = (mail: Pick<PressMail, "subject" | "body">) =>
  KEYWORDS.test(mail.subject) || KEYWORDS.test(mail.body.slice(0, 3000));

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ],
  })
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const DOWNLOAD_HINT = /wetransfer|we\.tl|dropbox|drive\.google|box\.com|pressefoto|press ?photo|pressebild|bildmaterial|artwork|hi-?res|download/i;

/** Bild- und Download-Links aus dem HTML einer Mail ziehen. */
const VIDEO_HINT = /youtube|video|musikvideo|clip|premiere|ansehen|watch now|play/i;
const NEVER_FOLLOW = /unsubscribe|abmelden|abbestellen|opt-?out|preferences|profil|forward|weiterleiten|webversion|view in browser|im browser/i;

export function extractImageLinks(html: string): Required<Pick<PressMail, "imageUrls" | "downloadLinks" | "videoIds" | "videoLinks">> {
  const videoLinks = new Set<string>();
  const urls = new Set<string>();
  const videos = new Set<string>();
  // Videos: verlinkt, eingebettet (iframe) oder als nackte URL im Text
  for (const [raw] of html.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const id = youtubeId(decodeEntities(raw));
    if (id) videos.add(id);
  }
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1];
    if (!src || !/^https?:/i.test(src)) continue;
    // Tracking-Pixel und Icons mit kleiner Größenangabe gar nicht erst laden
    const w = Number(tag.match(/\swidth=["']?(\d+)/i)?.[1] ?? 999);
    const h = Number(tag.match(/\sheight=["']?(\d+)/i)?.[1] ?? 999);
    if (w < 150 || h < 150) continue;
    urls.add(decodeEntities(src));
  }

  const downloadLinks: { url: string; label: string }[] = [];
  for (const [, href, inner] of html.matchAll(/<a\b[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = decodeEntities(href!);
    const label = stripTags(inner!);
    const imgHint = /<img/i.test(inner!) && VIDEO_HINT.test(inner!);
    if (!youtubeId(url) && (VIDEO_HINT.test(label) || imgHint) && !NEVER_FOLLOW.test(url + " " + label)) videoLinks.add(url);
    if (/\.(jpe?g|png|webp)(\?|$)/i.test(url)) urls.add(url);
    else if (DOWNLOAD_HINT.test(url) || DOWNLOAD_HINT.test(stripTags(inner!))) {
      if (!downloadLinks.some((l) => l.url === url)) downloadLinks.push({ url, label: stripTags(inner!).slice(0, 80) || url });
    }
  }
  return { imageUrls: [...urls].slice(0, 25), downloadLinks: downloadLinks.slice(0, 10), videoIds: [...videos].slice(0, 6), videoLinks: [...videoLinks].slice(0, 8) };
}

export async function parseMessage(uid: number, source: Buffer): Promise<PressMail> {
  const parsed = await simpleParser(source);
  const body = parsed.html ? htmlToText(parsed.html) : (parsed.text ?? "");
  const images = parsed.attachments
    .filter((a) => IMAGE_TYPES.includes(a.contentType))
    .map((a) => ({ filename: a.filename ?? "bild.jpg", contentType: a.contentType, data: a.content, inline: !!a.related, cid: a.cid }));
  const to = [parsed.to].flat().filter((a) => !!a).map((a) => a!.text).join(", ");

  return {
    uid,
    messageId: parsed.messageId ?? `uid:${uid}`,
    subject: parsed.subject ?? "",
    sender: parsed.from?.text ?? "",
    date: parsed.date?.toISOString() ?? "",
    body: body.trim().slice(0, MAX_BODY_CHARS),
    to,
    html: parsed.html || undefined,
    attachments: parsed.attachments.filter((a) => !a.related).map((a) => ({ filename: a.filename ?? "anhang", contentType: a.contentType, size: a.size })),
    images,
    ...(parsed.html ? extractImageLinks(parsed.html) : { videoIds: extractImageLinks(parsed.text ?? "").videoIds }),
  };
}

export class Mailbox {
  constructor(private cfg: Config["imap"]) {}

  /** Öffnet eine Verbindung, sperrt den Ordner und schließt beides wieder. */
  private async withFolder<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: true,
      auth: { user: this.cfg.user, pass: this.cfg.password },
      logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock(this.cfg.folder);
    try {
      return await fn(client);
    } finally {
      lock.release();
      await client.logout();
    }
  }

  /**
   * Alle noch nicht bearbeiteten Mails der letzten Tage, neueste zuerst.
   * `done` enthält die Message-IDs, die laut lokaler Datenbank schon erledigt sind –
   * nötig, weil nicht jeder Server eigene IMAP-Markierungen speichert.
   */
  candidates(done: Set<string> = new Set()): Promise<PressMail[]> {
    return this.withFolder(async (client) => {
      const since = new Date(Date.now() - this.cfg.maxAgeDays * 86_400_000);
      const uids =
        (await client.search(
          { since, not: { or: [{ keyword: DONE_FLAG }, { keyword: SKIPPED_FLAG }] } },
          { uid: true },
        )) || [];
      if (uids.length === 0) return [];

      // Erst nur die Kopfdaten holen, damit erledigte Mails nicht komplett geladen werden
      const open: number[] = [];
      for await (const msg of client.fetch(uids.join(","), { envelope: true, uid: true }, { uid: true })) {
        if (!done.has(msg.envelope?.messageId ?? `uid:${msg.uid}`)) open.push(msg.uid);
      }
      if (open.length === 0) return [];

      const mails: PressMail[] = [];
      // fetch() liest per BODY.PEEK – der Gelesen-Status bleibt unverändert
      for await (const msg of client.fetch(open.join(","), { source: true, uid: true }, { uid: true })) {
        if (msg.source) mails.push(await parseMessage(msg.uid, msg.source));
      }
      return mails.sort((a, b) => b.date.localeCompare(a.date));
    });
  }

  get(uid: number): Promise<PressMail | null> {
    return this.withFolder(async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      return msg && msg.source ? parseMessage(uid, msg.source) : null;
    });
  }

  /** Markierung setzen, soweit der Server das erlaubt; die verlässliche Merkliste ist die lokale Datenbank. */
  mark(uid: number, flag: typeof DONE_FLAG | typeof SKIPPED_FLAG): Promise<void> {
    return this.withFolder(async (client) => {
      await client.messageFlagsAdd(String(uid), [flag], { uid: true }).catch(() => false);
      if (flag === DONE_FLAG && this.cfg.processedFolder) {
        await client.messageMove(String(uid), this.cfg.processedFolder, { uid: true });
      }
    });
  }
}
