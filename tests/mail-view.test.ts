import { expect, test } from "bun:test";
import { mailCsp, mailLinks, renderMailHtml } from "../server/mail-view.ts";
import { compareDates, findDates } from "../web/src/dates.ts";

const mail = {
  uid: 1, messageId: "<1@test>", subject: "", sender: "", date: "", body: "",
  images: [{ filename: "logo.png", contentType: "image/png", data: Buffer.from("png"), cid: "logo@x" }],
  html: `<p onclick="x()">Hallo <img src="cid:logo@x"><script>alert(1)</script></p>
<a href="https://tickets.example.com/a?x=1&amp;y=2">Tickets</a> <a href="https://wetransfer.com/downloads/1">Pressefotos</a>
<a href="https://example.com/unsubscribe">Abmelden</a><form action="https://evil"><input></form>`,
};

test("Mail-HTML: ohne Skripte und Formulare, cid-Bilder eingesetzt, Links in neuem Tab", () => {
  const html = renderMailHtml(mail);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onclick");
  expect(html).not.toContain("<form");
  expect(html).toContain(`src="data:image/png;base64,${Buffer.from("png").toString("base64")}"`);
  expect(html).toContain('target="_blank"');
});

test("CSP: externe Bilder nur auf Wunsch, nie Skripte", () => {
  expect(mailCsp(false)).toContain("img-src data:;");
  expect(mailCsp(true)).toContain("img-src data: https:");
  expect(mailCsp(true)).toContain("default-src 'none'");
});

test("Links der Mail: Abmelden fällt weg, Pressefotos gesperrt", () => {
  expect(mailLinks(mail)).toEqual([
    { url: "https://tickets.example.com/a?x=1&y=2", label: "Tickets", blocked: false },
    { url: "https://wetransfer.com/downloads/1", label: "Pressefotos", blocked: true },
  ]);
});

test("Datumsangaben in allen üblichen Schreibweisen, keine Uhrzeiten oder Preise", () => {
  const found = findDates("Am 12.03.2027 in Köln, 14.3. in Wien, 1. April 2027 Berlin, March 5th, 2027 London, 7 May. Einlass 19.30 Uhr, Tickets 32,50 €, Version 2.1.4");
  expect(found.map((d) => `${d.key}${d.year ?? ""}`)).toEqual(["12.03.2027", "14.03.", "01.04.2027", "05.03.2027", "07.05."]);
});

test("Abgleich: fehlende, erfundene und Termine mit falschem Jahr", () => {
  const { fromMail, onlyArticle } = compareDates("12.03.2027 Hamburg, 14.03.2027 Köln, 15.03.2027 München", "12.03.2027 – Hamburg, 14.03.2026 – Köln, 20.03.2027 – Berlin");
  expect(fromMail.map((d) => d.match)).toEqual(["ok", "year", "missing"]);
  expect(onlyArticle.map((d) => d.text)).toEqual(["14.03.2026", "20.03.2027"]);
});
