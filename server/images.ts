/** Bilder einer Mail sammeln (Anhänge, eingebettet, verlinkt), Logos/Icons aussortieren und lokal zwischenspeichern. */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageSize } from "image-size";
import { IMAGE_TYPES, type ImageAttachment, type PressMail } from "./mail.ts";

export interface ImageInfo {
  id: string;
  origin: "anhang" | "eingebettet" | "verlinkt";
  filename: string;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  url?: string;
}

export interface MailImages {
  images: ImageInfo[];
  downloadLinks: { url: string; label: string }[];
}

/** Kleiner als das ist meist Logo, Icon, Button oder Trenner – als Beitragsbild unbrauchbar. */
const MIN_LONG_SIDE = 500;
const MIN_SHORT_SIDE = 250;
const MIN_BYTES = 15_000;
const MAX_BYTES = 15 * 1024 * 1024;
/** Sehr breite oder hohe Grafiken sind fast immer Banner oder Spacer. */
const MAX_ASPECT = 4;

const sha = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function measure(data: Buffer): { width: number; height: number } | null {
  try {
    const { width, height } = imageSize(data);
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

function usable(dim: { width: number; height: number }, bytes: number): boolean {
  const long = Math.max(dim.width, dim.height);
  const short = Math.min(dim.width, dim.height);
  return long >= MIN_LONG_SIDE && short >= MIN_SHORT_SIDE && bytes >= MIN_BYTES && long / short <= MAX_ASPECT;
}

/** Bild aus dem Netz laden – nur echte Bilder, mit Größen- und Zeitlimit. */
async function download(url: string): Promise<ImageAttachment | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (wordpress-mail-sync)" } });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES.includes(type)) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_BYTES) return null;
    const name = decodeURIComponent(new URL(res.url || url).pathname.split("/").pop() || "bild").replace(/[^\w.-]+/g, "_");
    return { filename: /\.\w{3,4}$/.test(name) ? name : `${name}.${EXT[type]}`, contentType: type, data };
  } catch {
    return null;
  }
}

/** Mehrere Downloads parallel, aber höchstens `limit` gleichzeitig. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

export class ImageStore {
  private pending = new Map<string, Promise<MailImages>>();

  constructor(private dir: string) {}

  private folder(messageId: string) {
    return join(this.dir, sha(messageId).slice(0, 16));
  }

  /** Bilder der Mail – beim ersten Aufruf gesammelt und gespeichert, danach aus dem Cache. */
  collect(mail: PressMail): Promise<MailImages> {
    const folder = this.folder(mail.messageId);
    const index = join(folder, "index.json");
    if (existsSync(index)) return Promise.resolve(JSON.parse(readFileSync(index, "utf8")) as MailImages);

    // gleichzeitige Anfragen für dieselbe Mail teilen sich einen Durchlauf
    let job = this.pending.get(folder);
    if (!job) {
      job = this.build(mail, folder, index).finally(() => this.pending.delete(folder));
      this.pending.set(folder, job);
    }
    return job;
  }

  private async build(mail: PressMail, folder: string, index: string): Promise<MailImages> {
    const candidates: (ImageAttachment & { origin: ImageInfo["origin"]; url?: string })[] = mail.images.map((a) => ({
      ...a, origin: a.inline ? "eingebettet" : "anhang",
    }));
    const downloaded = await pool(mail.imageUrls ?? [], 4, download);
    downloaded.forEach((img, i) => img && candidates.push({ ...img, origin: "verlinkt", url: mail.imageUrls![i] }));

    mkdirSync(folder, { recursive: true });
    const seen = new Set<string>();
    const images: ImageInfo[] = [];
    for (const c of candidates) {
      const dim = measure(c.data);
      if (!dim || !usable(dim, c.data.length)) continue;
      const id = sha(c.data).slice(0, 12);
      if (seen.has(id)) continue; // dasselbe Bild mehrfach eingebunden
      seen.add(id);
      writeFileSync(join(folder, id), c.data);
      images.push({ id, origin: c.origin, filename: c.filename, contentType: c.contentType, width: dim.width, height: dim.height, bytes: c.data.length, url: c.url });
    }
    // Größtes Bild zuerst – das ist der Vorschlag fürs Thumbnail
    images.sort((a, b) => b.width * b.height - a.width * a.height);

    const result: MailImages = { images, downloadLinks: mail.downloadLinks ?? [] };
    writeFileSync(index, JSON.stringify(result));
    return result;
  }

  async read(mail: Pick<PressMail, "messageId">, id: string): Promise<(ImageInfo & { data: Buffer }) | null> {
    if (!/^[0-9a-f]{12}$/.test(id)) return null;
    const folder = this.folder(mail.messageId);
    const index = join(folder, "index.json");
    if (!existsSync(index)) return null;
    const info = (JSON.parse(readFileSync(index, "utf8")) as MailImages).images.find((i) => i.id === id);
    return info ? { ...info, data: readFileSync(join(folder, id)) } : null;
  }
}
