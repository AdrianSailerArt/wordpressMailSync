import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageStore } from "../server/images.ts";
import { extractImageLinks, looksRelevant, parseMessage, youtubeId, type PressMail } from "../server/mail.ts";
import { ArticleSchema, cleanArticle, degender, isBlockedLink, keepMailLinks, slugify, stripBlockedUrls, stripPressLinks, tidyContent } from "../server/rewrite.ts";
import { insertAfterParagraph, videoHtml } from "../server/wordpress.ts";

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
    // Soundtrack ohne Tour, Album oder Ticket kommt trotzdem beim Sprachmodell an
    expect(looksRelevant(await parseMessage(1, rawMail("Neu: Original-Soundtrack zur Serie", "<p>Die Komponistin hat die Filmmusik geschrieben.</p>")))).toBe(true);
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

  test("eigenes Bild nachträglich: steht vorn, auch klein erlaubt, bleibt gespeichert, lässt sich entfernen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wms-img-"));
    try {
      const mail: PressMail = { uid: 1, messageId: "<eigen@test>", subject: "", sender: "", date: "", body: "",
        images: [{ filename: "bandfoto.png", contentType: "image/png", data: png(2400, 1600) }] };
      const store = new ImageStore(dir);
      const { image, images } = await store.add(mail, { filename: "Mein Thumbnail (1).png", contentType: "image/png", data: png(640, 360, 20_000) });
      expect(image).toMatchObject({ origin: "eigenes", width: 640, height: 360, filename: "Mein_Thumbnail_1_.png" });
      expect(images.images.map((i) => i.origin)).toEqual(["eigenes", "anhang"]);
      // neu geladen (z. B. nach Neustart) ist es noch da
      expect((await new ImageStore(dir).collect(mail)).images[0]?.id).toBe(image.id);
      expect((await store.read(mail, image.id))?.data.length).toBe(20_000);
      // dasselbe Bild nochmal: kein Duplikat
      expect((await store.add(mail, { filename: "x.png", contentType: "image/png", data: png(640, 360, 20_000) })).images.images).toHaveLength(2);

      await expect(store.add(mail, { filename: "x.gif", contentType: "image/gif", data: Buffer.from("GIF89a") })).rejects.toThrow("Nur JPEG, PNG oder WebP");
      await expect(store.add(mail, { filename: "x.png", contentType: "image/png", data: Buffer.from("kein bild") })).rejects.toThrow("kein lesbares Bild");

      const mailImage = images.images[1]!.id;
      await expect(store.remove(mail, mailImage)).rejects.toThrow("Nur selbst hochgeladene");
      expect((await store.remove(mail, image.id)).images.map((i) => i.origin)).toEqual(["anhang"]);
      expect(await store.read(mail, image.id)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Links und Videos", () => {
  test("YouTube-IDs aus allen Link-Formen, Kanäle zählen nicht", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=qWWILgG5yvE", "https://www.youtube.com/watch?feature=share&v=qWWILgG5yvE&t=59s",
      "https://youtu.be/qWWILgG5yvE?si=x", "https://www.youtube.com/embed/qWWILgG5yvE", "https://www.youtube-nocookie.com/embed/qWWILgG5yvE",
      "https://youtube.com/shorts/qWWILgG5yvE", "https://m.youtube.com/watch?v=qWWILgG5yvE",
    ]) expect(youtubeId(url)).toBe("qWWILgG5yvE");
    for (const url of ["https://www.youtube.com/@band", "https://www.youtube.com/user/TribeOnlineMagazin", "https://www.youtube.com/channel/UC123", "https://example.com/watch?v=qWWILgG5yvE"])
      expect(youtubeId(url)).toBeNull();
  });

  test("Videos werden in der Mail erkannt (Link, Player, Text)", () => {
    const { videoIds } = extractImageLinks(`<a href="https://youtu.be/AAAAAAAAAAA">Video</a>
      <iframe src="https://www.youtube.com/embed/BBBBBBBBBBB"></iframe> Jetzt ansehen: https://www.youtube.com/watch?v=CCCCCCCCCCC
      <a href="https://www.youtube.com/@band">Kanal abonnieren</a> <a href="https://youtu.be/AAAAAAAAAAA">nochmal</a>`);
    expect(videoIds).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]);
  });

  test("Video-Links hinter Klick-Zählern werden zum Auflösen vorgemerkt, Abmelde-Links nie", () => {
    const { videoLinks } = extractImageLinks(`
      <a href="https://x.cleverreach.com/c/1">Zum Musikvideo</a>
      <a href="https://us.list-manage.com/track/click?u=2"><img src="play-button.png" alt="Video ansehen"></a>
      <a href="https://x.cleverreach.com/c/3">Tickets</a>
      <a href="https://x.cleverreach.com/unsubscribe/4">Video-Newsletter abbestellen</a>
      <a href="https://youtu.be/AAAAAAAAAAA">Video</a>`);
    expect(videoLinks).toEqual(["https://x.cleverreach.com/c/1", "https://us.list-manage.com/track/click?u=2"]);
  });

  test("gesperrte Links: Downloads, Presseordner, Hörproben, Dateien", () => {
    for (const [href, text] of [
      ["https://we.tl/t-abc", "hier"], ["https://www.dropbox.com/s/x/fotos.zip", "Fotos"], ["https://drive.google.com/drive/folders/x", "Ordner"],
      ["https://label.example/presse/band", "Mehr"], ["https://label.example/files/album.zip", "Album"], ["https://label.example/info.pdf", "Info"],
      ["https://soundcloud.com/band/song/s-AbC123", "Song"], ["https://band.example", "Pressefotos herunterladen"], ["https://x.example", "Hörprobe"],
    ]) expect(isBlockedLink(href!, text)).toBe(true);
    for (const [href, text] of [
      ["https://tickets.example/band", "Tickets"], ["https://band.example", "Website"], ["https://napalmrecords.com/band", "Vorbestellen"],
      ["https://soundcloud.com/band/song", "Song"], ["https://open.spotify.com/album/x", "Spotify"],
    ]) expect(isBlockedLink(href!, text)).toBe(false);
  });

  test("Filter im Text: Absätze nur mit Link fallen weg, sonst bleibt der Text", () => {
    const out = stripPressLinks(`<p>Pressefotos: <a href="https://we.tl/t-abc">hier</a></p>` +
      `<p>Das Album erscheint über <a href="https://label.example/shop">Napalm Records</a>, Fotos im <a href="https://label.example/presse/">Presseordner</a>.</p>` +
      `<p>https://www.youtube.com/watch?v=qWWILgG5yvE</p><p>Das Video zu <a href="https://youtu.be/qWWILgG5yvE">„Anfang“</a> ist online.</p>` +
      `<ul><li>Hörprobe: <a href="https://soundcloud.com/b/s/s-AbC123">privat</a></li><li>12.03.2027 – Köln – Gloria</li></ul>`);
    expect(out).toBe(`<p>Das Album erscheint über <a href="https://label.example/shop">Napalm Records</a>, Fotos im Presseordner.</p>` +
      `<p>Das Video zu „Anfang“ ist online.</p><ul><li>12.03.2027 – Köln – Gloria</li></ul>`);
  });

  test("Presse-Plattformen und persönliche Verteiler-Links: auch als nackte URL in eckigen Klammern", () => {
    const promo = "https://www.promojukebox.com/mlgdel/?e=ZkxSa1BNUjNn%3D&c=57075222&p=THVJWARUHMA6LX49&checkcode=d597f56802e8295c&urlcc=f471a0c418a8acdb&acc=SzBpWUU5VE9q";
    expect(isBlockedLink(promo)).toBe(true);
    expect(isBlockedLink("https://www.promojukebox.com/", "Website")).toBe(true);
    expect(isBlockedLink(`https://tickets.example/band?${"x".repeat(120)}`)).toBe(true);
    expect(isBlockedLink("https://tickets.example/band?date=2027-03-12", "Tickets")).toBe(false);

    expect(stripPressLinks(`<p>Infos &amp; Tickets: [${promo}]</p><p>Mehr unter [https://band.example] und bald live.</p>`))
      .toBe(`<p>Mehr unter [https://band.example] und bald live.</p>`);
    expect(stripBlockedUrls(`Stream: Hier hören [${promo}]\nWebsite [https://band.example]`))
      .toBe("Stream: Hier hören \nWebsite [https://band.example]");
  });

  test("Platzhalter statt Link: Ticket-Zeile ohne Ziel fällt weg", () => {
    expect(tidyContent(`<p>Das Album erscheint am 20.11.2026.</p><p>Infos &amp; Tickets: [Link zu Reaper Entertainment oder offizielle Website]</p>`))
      .toBe("<p>Das Album erscheint am 20.11.2026.</p>");
    expect(tidyContent(`<p><strong>Tickets:</strong> [Ticket-Link]</p><p>Website: <a href="#">hier</a></p><ul><li>Infos: Link folgt</li></ul>`)).toBe("<ul></ul>");
    expect(tidyContent(`<p>Tickets gibt es ab Freitag über [Link zum Ticketshop].</p>`)).toBe("<p>Tickets gibt es ab Freitag.</p>");
    // echte Links und normale Absätze bleiben
    const ok = `<p>Infos &amp; Tickets: <a href="https://reaper-entertainment.de">reaper-entertainment.de</a></p><p>Tickets: ab 32 € im Vorverkauf</p>`;
    expect(tidyContent(ok)).toBe(ok);
  });

  test("Links, die nicht in der Mail stehen, verlieren ihren Link", () => {
    const mail = { body: "Tickets [https://tickets.example/band?x=1&y=2]", html: "" };
    expect(keepMailLinks(`<p><a href="https://tickets.example/band?x=1&amp;y=2">Tickets</a> und <a href="https://erfunden.example">Website</a></p>`, mail))
      .toBe(`<p><a href="https://tickets.example/band?x=1&amp;y=2">Tickets</a> und Website</p>`);
  });

  test("Video wird cookiefrei eingebunden: eigenes Vorschaubild mit Link, kein Player, keine nackte URL", () => {
    const video = { id: "qWWILgG5yvE", title: "Anfang <live>", channel: "Eisbrecher", url: "https://www.youtube.com/watch?v=qWWILgG5yvE" };
    const html = videoHtml(video, { id: 42, url: "https://www.tribe-online.de/wp-content/uploads/youtube-qWWILgG5yvE.jpg" });
    expect(html).toContain('class="wp-image-42"');
    expect(html).toContain('href="https://www.youtube.com/watch?v=qWWILgG5yvE"');
    expect(html).toContain("Anfang &lt;live&gt;");
    expect(html).not.toMatch(/<iframe|ytimg|youtube-nocookie/);
    expect(html).not.toMatch(/^\s*https?:\/\/\S+\s*$/m); // Jetpack würde aus einer URL-Zeile einen Player machen
    expect(videoHtml(video, null)).toContain("Video auf YouTube ansehen");
  });

  test("Einfügen nach dem n-ten Absatz", () => {
    expect(insertAfterParagraph("<p>a</p><p>b</p><p>c</p>", "X", 2)).toBe("<p>a</p><p>b</p>\nX\n<p>c</p>");
    expect(insertAfterParagraph("<p>a</p>", "X", 2)).toBe("<p>a</p>\nX\n");
    expect(insertAfterParagraph("ohne Absatz", "X", 2)).toBe("ohne Absatz\nX");
  });
});
