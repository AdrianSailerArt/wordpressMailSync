import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageStore } from "../server/images.ts";
import { extractImageLinks, looksRelevant, parseMessage, type PressMail } from "../server/mail.ts";
import { ArticleSchema, cleanArticle, degender, slugify, tidyContent } from "../server/rewrite.ts";

function rawMail(subject: string, html: string, image?: Buffer): Buffer {
  const boundary = "XYZ";
  const parts = [
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`,
    image
      ? `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Disposition: attachment; filename="press.jpg"\r\nContent-Transfer-Encoding: base64\r\n\r\n${image.toString("base64")}\r\n`
      : "",
  ];
  return Buffer.from(
    `Subject: ${subject}\r\nFrom: Promo <promo@label.example>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0100\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.join("")}--${boundary}--\r\n`,
  );
}

describe("Mail", () => {
  test("HTML wird zu Text, Links bleiben erhalten, Skripte verschwinden", async () => {
    const mail = await parseMessage(1, rawMail("Die Band – Tour 2027", '<p>Tickets <a href="https://tix.example">hier</a></p><script>x()</script>'));
    expect(mail.body).toContain("https://tix.example");
    expect(mail.body).not.toContain("x()");
    expect(looksRelevant(mail)).toBe(true);
  });

  test("Bild-Anhänge werden eingelesen", async () => {
    const mail = await parseMessage(1, rawMail("Tour", "<p>x</p>", Buffer.alloc(100)));
    expect(mail.images).toHaveLength(1);
    expect(mail.images[0]!.contentType).toBe("image/jpeg");
  });

  test("Bild- und Download-Links werden erkannt, Pixel und Icons nicht", () => {
    const { imageUrls, downloadLinks } = extractImageLinks(`
      <img src="https://cdn.example/foto.jpg?x=1&amp;y=2">
      <img src="https://track.example/pixel.gif" width="1" height="1">
      <img src="https://cdn.example/icon.png" width="24" height="24">
      <img src="cid:abc">
      <a href="https://cdn.example/hires.png">Hi-Res</a>
      <a href="https://we.tl/t-abc">hier</a>
      <a href="https://label.example/presse">Pressefotos herunterladen</a>
      <a href="https://label.example/shop">Shop</a>`);
    expect(imageUrls).toEqual(["https://cdn.example/foto.jpg?x=1&y=2", "https://cdn.example/hires.png"]);
    expect(downloadLinks.map((l) => l.url)).toEqual(["https://we.tl/t-abc", "https://label.example/presse"]);
  });

  test("Vorfilter verwirft Rechnungen", async () => {
    expect(looksRelevant(await parseMessage(1, rawMail("Ihre Rechnung", "<p>Betrag fällig</p>")))).toBe(false);
  });
});

describe("Artikel", () => {
  test("wir gendern nicht: Gender-Schreibweisen werden zum generischen Maskulinum", () => {
    const cases: [string, string][] = [
      ["Alle Künstler:innen und Musiker*innen", "Alle Künstler und Musiker"],
      ["Die BesucherInnen und Fan:innen feiern", "Die Besucher und Fans feiern"],
      ["Liebe Leser_innen, Kolleg:innen und Journalist/-innen", "Liebe Leser, Kollegen und Journalisten"],
      ["Sängerinnen und Sänger aus ganz Europa", "Sänger aus ganz Europa"],
      ["Gitarristen und Gitarristinnen gesucht", "Gitarristen gesucht"],
      ["Unser Redakteur:in schreibt", "Unser Redakteur schreibt"],
      ["Die Sängerin Mara Holt und der Gitarrist", "Die Sängerin Mara Holt und der Gitarrist"],
      ["Mehr auf LinkedIn und Berlin, Termine um 20:00 Uhr", "Mehr auf LinkedIn und Berlin, Termine um 20:00 Uhr"],
    ];
    for (const [input, expected] of cases) expect(degender(input)).toBe(expected);
  });

  test("Gendern im HTML: nur Text, Links bleiben unverändert", () => {
    expect(tidyContent('<p>Für alle Fan:innen: <a href="https://x.example/fan:innen">Tickets</a></p>'))
      .toBe('<p>Für alle Fans: <a href="https://x.example/fan:innen">Tickets</a></p>');
  });

  test("Formfehler lokaler Modelle werden bereinigt", () => {
    expect(tidyContent("<h2>Überschrift</h2><p>Die Band **ANKOR** spielt am 1.04.2027 und 12.03.2027.</p><h2>Termine</h2>"))
      .toBe("<p>Die Band <strong>ANKOR</strong> spielt am 01.04.2027 und 12.03.2027.</p><h2>Termine</h2>");
    const a = cleanArticle(ArticleSchema.parse({
      relevant: true, reason: "", title: "**ANKOR** Tour", meta_description: "Die Band **ANKOR** kommt *bald*.",
      excerpt: "**Neu:** Tour", content_html: "<p>x</p>",
    }), ["News"]);
    expect([a.title, a.meta_description, a.excerpt]).toEqual(["ANKOR Tour", "Die Band ANKOR kommt bald.", "Neu: Tour"]);
    expect(a.seo_title).toBe("ANKOR Tour");
  });

  test("slugify", () => {
    expect(slugify("Die Ärzte: Tour 2027 – alle Termine!")).toBe("die-aerzte-tour-2027-alle-termine");
  });

  test("cleanArticle entfernt gefährliches HTML und korrigiert die Kategorie", () => {
    const cleaned = cleanArticle(
      ArticleSchema.parse({
        relevant: true, reason: "", title: " Titel ", slug: "Mein Slug", meta_description: "m".repeat(200),
        category: "tourdaten", tags: ["a", " ", "b"],
        content_html: '<h1>X</h1><p onclick="evil()">Hi <a href="javascript:alert(1)">x</a> <a href="https://ok.example">ok</a></p><script>bad()</script>',
      }),
      ["News", "Tourdaten"],
    );
    expect(cleaned.content_html).not.toContain("<script");
    expect(cleaned.content_html).not.toContain("onclick");
    expect(cleaned.content_html).not.toContain("javascript:");
    expect(cleaned.content_html).not.toContain("<h1>");
    expect(cleaned.content_html).toContain('rel="noopener nofollow"');
    expect(cleaned.category).toBe("Tourdaten");
    expect(cleaned.slug).toBe("mein-slug");
    expect(cleaned.meta_description.length).toBeLessThanOrEqual(160);
    expect(cleaned.tags).toEqual(["a", "b"]);
  });
});

/** Minimale PNG-Datei mit gewünschten Maßen (reicht zum Ausmessen) und Füllbytes. */
function png(width: number, height: number, bytes = 50_000): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8; head[25] = 2;
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - 33), width % 251)]);
}

describe("Bilder", () => {
  test("Logos, Banner und Doppelte werden aussortiert, größtes Bild zuerst", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wms-img-"));
    try {
      const att = (name: string, data: Buffer) => ({ filename: name, contentType: "image/png", data });
      const mail: PressMail = {
        uid: 1, messageId: "<bilder@test>", subject: "", sender: "", date: "", body: "",
        images: [
          att("logo.png", png(300, 120)),
          att("banner.png", png(1200, 150)),
          att("winzig.png", png(800, 600, 2_000)),
          att("cover.png", png(1500, 1500)),
          att("bandfoto.png", png(2400, 1600)),
          att("bandfoto-kopie.png", png(2400, 1600)),
        ],
      };
      const store = new ImageStore(dir);
      const { images } = await store.collect(mail);
      expect(images.map((i) => i.filename)).toEqual(["bandfoto.png", "cover.png"]);
      expect(images[0]).toMatchObject({ width: 2400, height: 1600, origin: "anhang" });

      const read = await store.read(mail, images[1]!.id);
      expect(read?.data.length).toBe(50_000);
      expect(await store.read(mail, "../../etc/passwd")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
