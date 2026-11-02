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
const MIN_IMAGE_BYTES = 30_000; // Logos und Tracking-Pixel überspringen

export interface ImageAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface PressMail {
  uid: number;
  subject: string;
  sender: string;
  date: string;
  body: string;
  images: ImageAttachment[];
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

export async function parseMessage(uid: number, source: Buffer): Promise<PressMail> {
  const parsed = await simpleParser(source);
  const body = parsed.html ? htmlToText(parsed.html) : (parsed.text ?? "");
  const images = parsed.attachments
    .filter((a) => ["image/jpeg", "image/png", "image/webp"].includes(a.contentType) && a.size > MIN_IMAGE_BYTES)
    .sort((a, b) => b.size - a.size)
    .map((a) => ({ filename: a.filename ?? "bild.jpg", contentType: a.contentType, data: a.content }));

  return {
    uid,
    subject: parsed.subject ?? "",
    sender: parsed.from?.text ?? "",
    date: parsed.date?.toISOString() ?? "",
    body: body.trim().slice(0, MAX_BODY_CHARS),
    images,
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

  /** Alle noch nicht bearbeiteten Mails der letzten Tage, neueste zuerst. */
  candidates(): Promise<PressMail[]> {
    return this.withFolder(async (client) => {
      const since = new Date(Date.now() - this.cfg.maxAgeDays * 86_400_000);
      const uids =
        (await client.search(
          { since, not: { or: [{ keyword: DONE_FLAG }, { keyword: SKIPPED_FLAG }] } },
          { uid: true },
        )) || [];
      if (uids.length === 0) return [];

      const mails: PressMail[] = [];
      // fetch() liest per BODY.PEEK – der Gelesen-Status bleibt unverändert
      for await (const msg of client.fetch(uids.join(","), { source: true, uid: true }, { uid: true })) {
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

  mark(uid: number, flag: typeof DONE_FLAG | typeof SKIPPED_FLAG): Promise<void> {
    return this.withFolder(async (client) => {
      await client.messageFlagsAdd(String(uid), [flag], { uid: true });
      if (flag === DONE_FLAG && this.cfg.processedFolder) {
        await client.messageMove(String(uid), this.cfg.processedFolder, { uid: true });
      }
    });
  }
}
