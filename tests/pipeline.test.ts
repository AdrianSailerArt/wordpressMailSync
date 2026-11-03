import { beforeEach, expect, test } from "bun:test";
import type { Config } from "../server/config.ts";
import { Store } from "../server/db.ts";
import { DONE_FLAG, SKIPPED_FLAG, type PressMail } from "../server/mail.ts";
import { Pipeline } from "../server/pipeline.ts";
import { ArticleSchema } from "../server/rewrite.ts";

const cfg = {
  wp: { categories: ["News"], featuredImage: true },
  limits: { daily: 3, perRun: 1 },
} as unknown as Config;

const mail = (uid: number, subject: string, body = "…"): PressMail =>
  ({ uid, messageId: `<${uid}@test>`, subject, sender: "x", date: "", body, images: [] });

const MAILS = [
  mail(1, "Ihre Rechnung", "Betrag fällig"),
  mail(2, "Newsletter Tour", "Nichts Konkretes"),
  mail(3, "Band X – Tour 2027"),
  mail(4, "Band Y – neues Album"),
];

let marks: [number, string][];
let created: string[];
let uploaded: { featured?: string; inline: string[] }[];
let notified: string[];
let postedVideos: string[][];
let today: number;
let rewrites: number;

function pipeline() {
  marks = [];
  created = [];
  uploaded = [];
  notified = [];
  postedVideos = [];
  rewrites = 0;
  return new Pipeline(cfg, {
    mailbox: {
      // wie DomainFactory: Server speichert keine Markierungen, nur die lokale Datenbank filtert
      candidates: async (done = new Set()) => MAILS.filter((m) => !done.has(m.messageId)),
      get: async (uid) => MAILS.find((m) => m.uid === uid) ?? null,
      mark: async (uid, flag) => void marks.push([uid, flag]),
    },
    wordpress: {
      postsToday: async () => today,
      slugExists: async () => false,
      createPost: async (a, featured, inline = [], videos = []) => {
        created.push(a.slug);
        uploaded.push({ featured: featured?.filename, inline: inline.map((i) => i.filename) });
        postedVideos.push(videos.map((v) => v.video.id));
        return { id: 1, link: "https://wp/x" };
      },
    },
    // Mail 4 hat zwei Bilder, das größte steht vorn
    images: {
      collect: async (m) => ({
        images: m.uid === 4
          ? [{ id: "aaaaaaaaaaaa", filename: "gross.jpg" }, { id: "bbbbbbbbbbbb", filename: "klein.jpg" }]
            .map((i) => ({ ...i, origin: "verlinkt" as const, contentType: "image/jpeg", width: 1600, height: 900, bytes: 1 }))
          : [],
        downloadLinks: [],
        videos: m.uid === 4
          ? ["aaaaaaaaaaa", "bbbbbbbbbbb"].map((id) => ({ id, title: `Video ${id[0]}`, channel: "Band", url: `https://www.youtube.com/watch?v=${id}` }))
          : [],
      }),
      videoThumbnail: async (v) => ({ filename: `youtube-${v.id}.jpg`, contentType: "image/jpeg", data: Buffer.from("x") }),
      read: async (_m, id) => ({
        id, origin: "verlinkt", filename: id === "aaaaaaaaaaaa" ? "gross.jpg" : "klein.jpg",
        contentType: "image/jpeg", width: 1600, height: 900, bytes: 1, data: Buffer.from("x"),
      }),
    },
    notifier: { notify: async (n) => void notified.push(n.body) },
    rewriter: {
      rewrite: async (m) => {
        rewrites++;
        return m.subject.includes("Newsletter")
          ? ArticleSchema.parse({ relevant: false, reason: "kein Inhalt" })
          : ArticleSchema.parse({ relevant: true, reason: "", title: m.subject, slug: `post-${m.uid}`, category: "News" });
      },
    },
    store: new Store(":memory:"),
  });
}

beforeEach(() => {
  today = 0;
});

test("ein Beitrag pro Lauf, Mails werden korrekt markiert", async () => {
  const result = await pipeline().run();
  expect(result.published).toHaveLength(1);
  expect(created).toEqual(["post-3"]);
  expect(marks).toEqual([[1, SKIPPED_FLAG], [2, SKIPPED_FLAG], [3, DONE_FLAG]]);
});

test("Richtwert erreicht: Zeitplan veröffentlicht nichts", async () => {
  today = 3;
  const result = await pipeline().run();
  expect(result.message).toContain("Richtwert");
  expect(created).toEqual([]);
  expect(marks).toEqual([]);
});

test("Testlauf veröffentlicht und markiert nichts", async () => {
  const result = await pipeline().run(true);
  expect(result.previews.map((a) => a.slug)).toEqual(["post-3"]);
  expect(created).toEqual([]);
  expect(marks).toEqual([]);
});

test("Vorschau wird zwischengespeichert, bearbeiteter Entwurf wird veröffentlicht", async () => {
  const p = pipeline();
  const draft = await p.preview(4);
  await p.preview(4);
  expect(rewrites).toBe(1);

  p.saveDraft(4, { ...draft, title: "Eigener Titel", slug: "eigener-titel" });
  await p.publish(4);
  expect(rewrites).toBe(1);
  expect(created).toEqual(["eigener-titel"]);
  expect(marks).toEqual([[4, DONE_FLAG]]);
});

test("Richtwert erreicht: manuell veröffentlichen geht trotzdem", async () => {
  today = 3;
  const p = pipeline();
  expect((await p.run()).message).toContain("Richtwert");
  expect((await p.run(false, { manual: true })).published).toHaveLength(1);
  await p.publish(4);
  expect(created).toEqual(["post-3", "post-4"]);
});

test("ohne IMAP-Markierungen: erledigte Mails kommen nicht wieder", async () => {
  const p = pipeline();
  await p.run();
  await p.run();
  expect(created).toEqual(["post-3", "post-4"]);
  const third = await p.run();
  expect(third.published).toHaveLength(0);
  expect(await p.listMails()).toHaveLength(0);
});

test("Thumbnail: automatisch das größte Bild, sonst die Auswahl aus dem Entwurf", async () => {
  const p = pipeline();
  await p.publish(4);
  expect(uploaded[0]).toEqual({ featured: "gross.jpg", inline: [] });
});

test("Thumbnail und Bilder im Text gemäß Auswahl", async () => {
  const p = pipeline();
  const draft = await p.preview(4);
  p.saveDraft(4, { ...draft, featured_image: "bbbbbbbbbbbb", inline_images: ["aaaaaaaaaaaa"] });
  await p.publish(4);
  expect(uploaded[0]).toEqual({ featured: "klein.jpg", inline: ["gross.jpg"] });
});

test("„Kein Beitragsbild“ wird respektiert", async () => {
  const p = pipeline();
  const draft = await p.preview(4);
  p.saveDraft(4, { ...draft, featured_image: "none" });
  await p.publish(4);
  expect(uploaded[0]).toEqual({ featured: undefined, inline: [] });
});

test("Vorschlag: erzeugt Entwurf, benachrichtigt, veröffentlicht nichts", async () => {
  const p = pipeline();
  const result = await p.suggest();
  // Mail 1 fällt durch den Vorfilter, Mail 2 ist laut Modell nicht relevant → Mail 3 wird vorgeschlagen
  expect(result.suggested?.uid).toBe(3);
  expect(notified).toEqual(["Band X – Tour 2027"]);
  expect(created).toEqual([]);
  expect(marks).toEqual([[2, SKIPPED_FLAG]]);

  // zweiter Lauf schlägt die nächste Mail vor, nicht dieselbe noch einmal
  expect((await p.suggest()).suggested?.uid).toBe(4);
});

test("Videos: automatisch das erste, sonst Auswahl oder keins", async () => {
  let p = pipeline();
  await p.publish(4);
  expect(postedVideos).toEqual([["aaaaaaaaaaa"]]);

  p = pipeline();
  let draft = await p.preview(4);
  p.saveDraft(4, { ...draft, videos: ["bbbbbbbbbbb", "aaaaaaaaaaa"] });
  await p.publish(4);
  expect(postedVideos).toEqual([["bbbbbbbbbbb", "aaaaaaaaaaa"]]);

  p = pipeline();
  draft = await p.preview(4);
  p.saveDraft(4, { ...draft, videos: [] });
  await p.publish(4);
  expect(postedVideos).toEqual([[]]);
});
