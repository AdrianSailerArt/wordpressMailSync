import { expect, test } from "bun:test";
import type { Config } from "../server/config.ts";
import { Store } from "../server/db.ts";
import { fingerprint, groupDuplicates, isDuplicate, subjectKey } from "../server/duplicates.ts";
import { DONE_FLAG, SKIPPED_FLAG, mailId, splitMailId, type PressMail } from "../server/mail.ts";
import { Pipeline } from "../server/pipeline.ts";
import { ArticleSchema } from "../server/rewrite.ts";

const TEXT = `Die Berliner Indie-Band Nordlicht Kollektiv geht im Frühjahr 2027 mit ihrem dritten Album „Weite“ auf große Tour
durch Deutschland und Österreich. Das Album erscheint am 14. Februar über Sternklang Records und wurde in einer alten Scheune
in Brandenburg aufgenommen. Die Termine: 12.03.2027 Hamburg Uebel & Gefährlich, 14.03.2027 Köln Gloria, 15.03.2027 München
Technikum, 18.03.2027 Wien Flex. Tickets gibt es ab Freitag um 10 Uhr im Vorverkauf.`;

const mail = (uid: number, subject: string, body: string, extra: Partial<PressMail> = {}): PressMail =>
  ({ uid, messageId: `<${uid}@test>`, subject, sender: "promo@agentur.example", date: `2026-11-0${uid % 9}T10:00:00Z`, body, images: [], ...extra });

test("Betreff ohne Weiterleitungs- und Presse-Präfixe", () => {
  expect(subjectKey("AW: [Presse] PRESSEINFO: Nordlicht Kollektiv – „Weite“ Tour 2027")).toBe("nordlicht kollektiv weite tour 2027");
  expect(subjectKey("Fwd: Nordlicht Kollektiv - Weite Tour 2027!")).toBe("nordlicht kollektiv weite tour 2027");
});

test("gleiche Mail mit persönlicher Anrede und eigenen Klick-Zählern ist eine Dublette", () => {
  const a = mail(1, "PRESSEINFO: Nordlicht Kollektiv – Weite Tour 2027", `Hallo Marco,\n\n${TEXT}\nhttps://t.agentur.example/c/111\nViele Grüße`);
  const b = mail(2, "Nordlicht Kollektiv – Weite Tour 2027", `Liebe Redaktion,\n\n${TEXT}\nhttps://t.agentur.example/c/999\nBeste Grüße, Lena`);
  expect(isDuplicate(fingerprint(a), fingerprint(b))).toBe(true);
});

test("gleicher Text unter anderem Betreff (Label und Agentur) ist eine Dublette", () => {
  const a = mail(1, "Nordlicht Kollektiv auf Tour", TEXT);
  const b = mail(2, "Tourdaten 2027: Nordlicht Kollektiv kommen", `${TEXT} Rückfragen gern an presse@label.example.`);
  expect(isDuplicate(fingerprint(a), fingerprint(b))).toBe(true);
});

test("Newsletter mit gleicher Vorlage, aber anderem Thema: keine Dublette", () => {
  const footer = TEXT; // stellvertretend für lange, immer gleiche Fußzeilen und Rechtstexte
  const a = mail(1, "4-in-1 Akku-Autostaubsauger 12000 Pa", `Jetzt zugreifen! ${footer}`);
  const b = mail(2, "40V Akku-Turbinen-Laubbläser statt 239 € nur 119 €", `Nur heute! ${footer}`);
  expect(isDuplicate(fingerprint(a), fingerprint(b))).toBe(false);
});

test("gleiche Vorlage, anderer Künstler: keine Dublette", () => {
  const other = TEXT.replaceAll("Nordlicht Kollektiv", "Mira Sol").replace("„Weite“", "„Glas“")
    .replace("Berliner Indie-Band", "Leipziger Sängerin").replace(/\d\d\.03\.2027 \w+ [^,.]+/g, "20.04.2027 Leipzig Conne Island");
  const a = mail(1, "Nordlicht Kollektiv – Tour 2027", TEXT);
  const b = mail(2, "Mira Sol – Tour 2027", other);
  expect(isDuplicate(fingerprint(a), fingerprint(b))).toBe(false);
});

test("gleicher Betreff, aber kaum Text: keine Dublette auf Verdacht", () => {
  expect(isDuplicate(fingerprint(mail(1, "Newsletter November", "Hallo")), fingerprint(mail(2, "Newsletter November", "Hi")))).toBe(false);
});

test("Gruppe: Mail mit Entwurf bleibt Hauptmail, sonst die zuerst eingegangene", () => {
  const a = mail(1, "Tour 2027", TEXT);
  const b = mail(2, "Tour 2027", TEXT, { messageId: "<anders@test>" });
  const c = mail(3, "Etwas anderes", "Ganz andere Nachricht über ein Festival im Sommer mit vielen Bands und Bühnen");
  expect(groupDuplicates([b, a, c]).map((g) => [g.mail.uid, g.duplicates.map((d) => d.uid)])).toEqual([[1, [2]], [3, []]]);
  expect(groupDuplicates([b, a, c], (m) => m.uid === 2)[0]!.mail.uid).toBe(2);
});

test("Mail-IDs: erstes Postfach behält die UID, weitere sind eindeutig", () => {
  expect(mailId(0, 4711)).toBe(4711);
  expect(splitMailId(mailId(2, 4711))).toEqual({ account: 2, uid: 4711 });
});

// --- Zusammenspiel mit der Pipeline: zwei Postfächer ---

const cfg = { wp: { categories: ["News"], featuredImage: false }, limits: { perRun: 1 } } as unknown as Config;

function setup(mails: PressMail[]) {
  const marks: [number, string][] = [];
  const created: string[] = [];
  const store = new Store(":memory:");
  const pipeline = new Pipeline(cfg, {
    mailbox: {
      candidates: async (done = new Set()) => mails.filter((m) => !done.has(m.messageId)),
      get: async (uid) => mails.find((m) => m.uid === uid) ?? null,
      mark: async (uid, flag) => void marks.push([uid, flag]),
      status: () => [{ name: "redaktion", folder: "INBOX" }, { name: "presse", folder: "INBOX" }],
    },
    wordpress: {
      postsToday: async () => 0,
      slugExists: async () => false,
      createPost: async (a) => (created.push(a.slug), { id: 1, link: "https://wp/x" }),
    },
    images: { collect: async () => ({ images: [], downloadLinks: [], videos: [] }), read: async () => null, videoThumbnail: async () => null },
    rewriter: { rewrite: async (m) => ArticleSchema.parse({ relevant: true, reason: "", title: m.subject, slug: `post-${m.uid}`, category: "News" }) },
    store,
  });
  return { pipeline, marks, created, store };
}

const first = mail(5, "PRESSEINFO: Nordlicht Kollektiv – Weite Tour 2027", `Hallo,\n${TEXT}`, { account: "redaktion" });
const second = mail(mailId(1, 5), "Nordlicht Kollektiv – Weite Tour 2027", `Liebe Redaktion,\n${TEXT}`, { account: "presse", messageId: "<x@presse>", date: "2026-11-05T11:00:00Z" });
const other = mail(6, "Mira Sol – neue Single „Glas“", "Mira Sol veröffentlicht am 14. November ihre neue Single „Glas“ als erste Auskopplung aus dem kommenden Album.", { account: "presse" });

test("Liste: Dublette aus dem zweiten Postfach wird zusammengefasst und gekennzeichnet", async () => {
  const { pipeline } = setup([first, second, other]);
  const list = await pipeline.listMails();
  expect(list.map((m) => m.uid)).toEqual([5, 6]);
  expect(list[0]!.duplicates).toEqual([{ uid: mailId(1, 5), account: "presse", sender: second.sender, subject: second.subject, date: second.date }]);
  expect(list[0]!.account).toBe("redaktion");
});

test("Veröffentlichen erledigt alle Exemplare – nur ein Beitrag", async () => {
  const { pipeline, marks, created } = setup([first, second, other]);
  await pipeline.listMails();
  await pipeline.publish(5);
  expect(created).toEqual(["post-5"]);
  expect(marks).toEqual([[5, DONE_FLAG], [mailId(1, 5), DONE_FLAG]]);
  expect((await pipeline.listMails()).map((m) => m.uid)).toEqual([6]);
});

test("Dublette, die erst nach dem Veröffentlichen ankommt, wird automatisch übersprungen", async () => {
  const mails = [first, other];
  const { pipeline, marks, created, store } = setup(mails);
  await pipeline.publish(first.uid);
  expect(created).toEqual(["post-5"]);

  mails.push(second); // kommt später im zweiten Postfach an
  expect((await pipeline.listMails()).map((m) => m.uid)).toEqual([6]);
  expect(marks).toContainEqual([mailId(1, 5), SKIPPED_FLAG]);
  expect(store.recentLog().some((l) => l.detail.includes("Dublette aus presse"))).toBe(true);
});
