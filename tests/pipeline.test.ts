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
let today: number;
let rewrites: number;

function pipeline() {
  marks = [];
  created = [];
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
      createPost: async (a) => (created.push(a.slug), { id: 1, link: "https://wp/x" }),
    },
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

test("Tageslimit erreicht: nichts passiert", async () => {
  today = 3;
  const result = await pipeline().run();
  expect(result.message).toContain("Tageslimit");
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

test("manuelles Veröffentlichen respektiert das Tageslimit", async () => {
  today = 3;
  expect(pipeline().publish(3)).rejects.toThrow("Tageslimit");
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
