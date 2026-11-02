import { describe, expect, test } from "bun:test";
import { looksRelevant, parseMessage } from "../server/mail.ts";
import { ArticleSchema, cleanArticle, slugify } from "../server/rewrite.ts";

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

  test("kleine Bilder werden ignoriert, große übernommen", async () => {
    expect((await parseMessage(1, rawMail("Tour", "<p>x</p>", Buffer.alloc(100)))).images).toHaveLength(0);
    expect((await parseMessage(1, rawMail("Tour", "<p>x</p>", Buffer.alloc(50_000)))).images).toHaveLength(1);
  });

  test("Vorfilter verwirft Rechnungen", async () => {
    expect(looksRelevant(await parseMessage(1, rawMail("Ihre Rechnung", "<p>Betrag fällig</p>")))).toBe(false);
  });
});

describe("Artikel", () => {
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
