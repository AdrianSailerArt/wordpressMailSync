import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadQuellen, QuellenSchema } from "../server/kalender/events.ts";
import { addLocation, editQuellen, formatQuellen, newId, removeLocation, removeOrt, setOrt, typFor, updateLocation } from "../server/kalender/locations.ts";
import { einordnen, erkennen, nameFrom } from "../server/kalender/erkennen.ts";

const quellen = loadQuellen("kalender/quellen.json");
const input = { name: "Café Neu", url: "https://cafe-neu.example/programm", ort: "Kandern", land: "de" };

describe("Locations pflegen", () => {
  test("id aus dem Namen, eindeutig", () => {
    expect(newId("Café Atlantik", [])).toBe("cafe-atlantik");
    expect(newId("Bird's Eye Jazz Club", [])).toBe("bird-s-eye-jazz-club");
    expect(newId("Jazzhaus", ["jazzhaus", "jazzhaus-2"])).toBe("jazzhaus-3");
  });

  test("regioactive.de erkennt der feste Parser, alles andere liest das Sprachmodell", () => {
    expect(typFor("https://www.regioactive.de/location/x/y-123")).toBe("regioactive");
    expect(typFor("https://www.jazzhaus.de/programm")).toBe("seite");
  });

  test("anlegen: vor den Veranstaltern einsortiert, neuer Ort kommt ins Gebiet", () => {
    const { quellen: q, quelle } = addLocation(quellen, input);
    expect(quelle).toEqual({ typ: "seite", id: "cafe-neu", name: "Café Neu", url: input.url, location: "Café Neu", ort: "Kandern", land: "DE" });
    const i = q.quellen.findIndex((x) => x.id === "cafe-neu");
    expect(q.quellen.slice(i + 1).every((x) => x.typ !== "seite" && x.typ !== "regioactive")).toBe(true);
    expect(q.orte.Kandern).toBe("DE");
    expect(() => QuellenSchema.parse(q)).not.toThrow();
  });

  test("anlegen: dieselbe Adresse nicht doppelt, Pflichtfelder lesbar gemeldet", () => {
    expect(() => addLocation(quellen, { ...input, url: "https://www.jazzhaus.de/programm/" })).toThrow("schon als Quelle");
    expect(() => addLocation(quellen, { ...input, url: "jazzhaus" })).toThrow("Keine gültige Adresse");
    expect(() => addLocation(quellen, { ...input, ort: " " })).toThrow("Ort fehlt");
  });

  test("ändern behält die id, feste Parser bleiben gesperrt", () => {
    const { quelle } = updateLocation(quellen, "jazzhaus", { ...input, name: "Jazzhaus Freiburg" });
    expect(quelle.id).toBe("jazzhaus");
    expect(quelle.name).toBe("Jazzhaus Freiburg");
    expect(() => updateLocation(quellen, "vaddi", input)).toThrow("festen Parser");
    expect(() => removeLocation(quellen, "ticketmaster")).toThrow("festen Parser");
  });

  test("löschen", () => {
    expect(removeLocation(quellen, "jazzhaus").quellen.some((x) => x.id === "jazzhaus")).toBe(false);
    expect(() => removeLocation(quellen, "gibtsnicht")).toThrow("gibt es nicht");
  });

  test("Datei: eine Quelle pro Zeile, liest sich wieder gleich", () => {
    const path = join(mkdtempSync(join(tmpdir(), "quellen-")), "quellen.json");
    writeFileSync(path, readFileSync("kalender/quellen.json"));
    editQuellen(path, (q) => {
      const r = addLocation(q, input);
      return { quellen: r.quellen, result: r.quelle };
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain('    { "typ": "seite", "id": "cafe-neu", "name": "Café Neu"');
    expect(loadQuellen(path).quellen).toHaveLength(quellen.quellen.length + 1);
    expect(formatQuellen(loadQuellen(path))).toBe(text);
  });
});

describe("Orte pflegen", () => {
  test("neuer Ort, vorhandener Ort behält seine Schreibweise", () => {
    expect(setOrt(quellen, { name: "Kandern", land: "de" }).orte.Kandern).toBe("DE");
    const q = setOrt(quellen, { name: "freiburg", land: "CH" });
    expect(q.orte.Freiburg).toBe("CH");
    expect("freiburg" in q.orte).toBe(false);
    expect(() => setOrt(quellen, { name: "X", land: "Deutschland" })).toThrow("Kürzel");
  });

  test("entfernen nur, wenn keine Location dort liegt", () => {
    expect("Aarau" in removeOrt(quellen, "Aarau").orte).toBe(false);
    expect(() => removeOrt(quellen, "Freiburg")).toThrow("Jazzhaus");
    expect(() => removeOrt(quellen, "Atlantis")).toThrow("gibt es nicht");
  });
});

describe("Seite erkennen", () => {
  const programm = `<html><head><title>Programm | Kulturhaus Kandern</title></head><body>
    <nav><a href="/">Start</a></nav>
    <h1>Programm</h1>
    ${["14.11.", "21.11.", "05.12.", "12.12."].map((d) => `<p>${d} 20:00 Uhr – Konzert mit einer Band aus der Region, Tickets an der Abendkasse und im Vorverkauf.</p>`).join("\n")}
    <footer>Kulturhaus · Hauptstraße 1 · 79400 Kandern · 79400 Kandern</footer></body></html>`;

  test("Programm-Seite: Sprachmodell, Name aus dem Titel, Ort über die Postleitzahl", () => {
    const e = einordnen("https://kulturhaus.example/programm", programm, { ...quellen.orte, Kandern: "DE" });
    expect(e).toMatchObject({ typ: "seite", urteil: "gut", termine: 4, vorschlag: { name: "Kulturhaus Kandern", ort: "Kandern", land: "DE" } });
  });

  test("Startseite ohne Termine: unsicher, verlinkte Programm-Seite wird vorgeschlagen", () => {
    const start = `<html><head><meta property="og:site_name" content="Kulturhaus &amp; Bar"></head><body>
      <a href="/programm/">Programm</a> <a href="https://andere.example/termine">Termine</a> <a href="/kontakt">Kontakt</a>
      <p>${"Willkommen im Kulturhaus, wir freuen uns auf euren Besuch und gute Musik. ".repeat(5)}</p></body></html>`;
    const e = einordnen("https://kulturhaus.example/", start, quellen.orte);
    expect(e.urteil).toBe("unsicher");
    expect(e.vorschlag.name).toBe("Kulturhaus & Bar");
    expect(e.programmLinks).toEqual([{ text: "Programm", url: "https://kulturhaus.example/programm/" }]);
    expect(einordnen("https://kulturhaus.example/programm", start, quellen.orte).programmLinks).toEqual([]);
  });

  test("Seite ohne Text lädt per JavaScript nach", () => {
    expect(einordnen("https://spa.example/", `<div id="app"></div><script src="app.js"></script>`, quellen.orte).urteil).toBe("ungeeignet");
  });

  test("regioactive: fester Parser, Ort aus der Adresse", () => {
    const html = `<h1>Mehlsack</h1><div class="preview clickdiv"><a href="/konzert/x-ABCDEFGH12"><h3>Band A</h3></a><time datetime="2026-12-01T20:00"></time><div class="mt-3 text-sm text-gray-500">Rock</div></div>`;
    const e = einordnen("https://www.regioactive.de/location/emmendingen-mundingen/mehlsack-FPMgKx4w7N", html, quellen.orte);
    expect(e).toMatchObject({ typ: "regioactive", urteil: "gut", termine: 1, vorschlag: { name: "Mehlsack", ort: "Emmendingen", land: "DE" } });
    expect(einordnen("https://www.regioactive.de/suche?q=x", html, quellen.orte).urteil).toBe("ungeeignet");
  });

  test("feste Parser werden nicht als Location angelegt", async () => {
    expect((await erkennen("https://z-7.ch/programm", quellen)).hinweis).toContain("schon als Quelle eingetragen");
    expect(() => addLocation(quellen, { ...input, url: "https://www.regioactive.de/suche?q=x" })).toThrow("Location-Seite");
    expect((await erkennen("https://www.jazzhaus.de/programm/", quellen)).hinweis).toContain("schon als „Jazzhaus“");
  });

  test("Name aus dem Titel ohne „Programm“", () => {
    expect(nameFrom("<title>Programm – Jazzhaus Freiburg</title>")).toBe("Jazzhaus Freiburg");
  });
});
