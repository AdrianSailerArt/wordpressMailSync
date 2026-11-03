import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countryOf, isSameEvent, isUpcoming, loadQuellen, mergeDuplicates, sameCity, type KonzertEvent } from "../server/kalender/events.ts";
import { chunks, dateInText, looksLikeProgram, toEvents } from "../server/kalender/seite.ts";
import { Kalender, type KalenderResult } from "../server/kalender/sync.ts";
import { compare, prepare, type WpEvent } from "../server/kalender/abgleich.ts";
import type { KalenderConfig } from "../server/config.ts";
import { geohash, mapTicketmaster } from "../server/kalender/ticketmaster.ts";
import { filterVaddi, looksLikeMusic, parseDescription, parseVaddi } from "../server/kalender/vaddi.ts";

const quellen = loadQuellen("kalender/quellen.json");

const event = (over: Partial<KonzertEvent>): KonzertEvent => ({
  uid: "x", source: "a", date: "2026-11-30", time: "", artists: ["Mighty Oaks"], title: "Mighty Oaks",
  venue: "Jazzhaus", city: "Freiburg", country: "DE", info: "", url: "", status: "", ...over,
});

const vaddiBlock = (day: string, artist: string, ort: string, extra = "") => `
<div class="event">
  <div class="eventwrap">
    <div class="eldata">
      <div class="col eltitle"><h2>${artist}</h2><div class="text"><p>
        // Tour 2026
      </p></div></div>
      <div class="col elsubtext ellocationwrap">
        Ort: ${ort}
      </div>
      <div class="col elsubtext elweekdaywrap"><span class="elweekday">Montag</span> ${day}</div>
      <div class="col elsubtext elstarttimewrap"><span class="elstarttimelabel"> Beginn: </span><span class="elstarttime"> 20:00 Uhr</span></div>
    </div>
  </div>
  ${extra}
  <div class="col elsubtext elinfolinkwrap">
    <a class="ellink elinfolink" href="/events-tickets/veranstaltungsdetails/x/${artist.toLowerCase().replace(/ /g, "-")}">Infos</a>
  </div>
</div>`;

describe("Vaddi", () => {
  const html = vaddiBlock("30.11.2026", "Mighty Oaks", "Freiburg, Jazzhaus", '<span class="elinfo elinfosoldout"> Ausverkauft </span>')
    + vaddiBlock("08.11.2026", "soffie", "Stuttgart, Im Wizemann (Club)")
    + vaddiBlock("06.08.2027", "PUR", "Karlsruhe; Schloss");

  test("Termine mit Ort, Location, Uhrzeit, Hinweis und Link", () => {
    const [oaks] = parseVaddi(html, "https://www.vaddi-concerts.de/");
    expect(oaks).toMatchObject({
      date: "2026-11-30", time: "20:00", artists: ["Mighty Oaks"], title: "Mighty Oaks – Tour 2026",
      venue: "Jazzhaus", city: "Freiburg", info: "Tour 2026", status: "Ausverkauft",
      url: "https://www.vaddi-concerts.de/events-tickets/veranstaltungsdetails/x/mighty-oaks",
    });
  });

  test("nur Orte im Gebiet, auch mit Semikolon", () => {
    const kept = filterVaddi(parseVaddi(html, "https://www.vaddi-concerts.de/"), quellen);
    expect(kept.map((e) => e.artists[0])).toEqual(["Mighty Oaks", "PUR"]);
    expect(kept[1]).toMatchObject({ city: "Karlsruhe", venue: "Schloss" });
  });

  test("Comedy erkennt man an der Beschreibung", () => {
    expect(looksLikeMusic("Humor, der unter die Haut geht: sein neues Live-Programm – ein Abend mit Lachmuskelkater.")).toBe(false);
    expect(looksLikeMusic("Mighty Oaks kehren mit voller Band zurück, neue Songs vom kommenden Album.")).toBe(true);
    expect(parseDescription('<div class="edtext eddescription"><p>Erster.</p><p>Zweiter Absatz.</p></div>')).toBe("Erster. Zweiter Absatz.");
  });
});

describe("Ticketmaster", () => {
  test("Geohash (Beispiel aus der Wikipedia)", () => {
    expect(geohash(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });

  const tm = {
    id: "Z1", name: "Bob Dylan", url: "https://ticketmaster.de/event/Z1",
    dates: { start: { localDate: "2026-11-17", localTime: "20:00:00" }, status: { code: "onsale" } },
    priceRanges: [{ min: 89.9, currency: "EUR" }],
    _embedded: {
      venues: [{ name: "SICK-Arena", city: { name: "Freiburg" }, country: { countryCode: "DE" }, location: { latitude: "48.02", longitude: "7.83" } }],
      attractions: [{ name: "Bob Dylan" }],
    },
  };

  test("Termin mit Preis", () => {
    expect(mapTicketmaster(tm, quellen.gebiet, quellen.ausschliessen)).toMatchObject({
      uid: "ticketmaster:Z1", date: "2026-11-17", time: "20:00", artists: ["Bob Dylan"], venue: "SICK-Arena",
      city: "Freiburg", country: "DE", info: "Tickets ab 89,90\u00a0€", status: "",
    });
  });

  test("Parkplätze und Orte außerhalb fallen weg, Absagen werden markiert", () => {
    expect(mapTicketmaster({ ...tm, name: "Parken – Bob Dylan" }, quellen.gebiet, [])).toBeNull();
    const munich = { ...tm._embedded.venues[0]!, location: { latitude: "48.14", longitude: "11.58" } };
    expect(mapTicketmaster({ ...tm, _embedded: { ...tm._embedded, venues: [munich] } }, quellen.gebiet, [])).toBeNull();
    expect(mapTicketmaster({ ...tm, dates: { ...tm.dates, status: { code: "cancelled" } } }, quellen.gebiet, [])?.status).toBe("Abgesagt");
  });
});

describe("Veranstalter-Seiten", () => {
  const q = { typ: "seite" as const, id: "jazzhaus", name: "Jazzhaus", url: "https://www.jazzhaus.de/programm", location: "Jazzhaus", ort: "Freiburg", land: "DE" };
  const text = "Do 05.11. Fred Wesley – Generations, VVK € 34\nSa, 14. November Grandbrothers im Theater\nMo 30.11. Mighty Oaks";
  const raw = (events: object[]) => ({ events: events.map((e) => ({ time: "", title: "", info: "", venue: "", status: "", artists: [], ...e })) });

  test("Datum im Text in verschiedenen Schreibweisen", () => {
    expect(dateInText("2026-11-05", text)).toBe(true);
    expect(dateInText("2026-11-14", text)).toBe(true);
    expect(dateInText("2026-11-15", text)).toBe(false);
    expect(dateInText("2026-03-14", "14 mars : concert")).toBe(true);
    expect(dateInText("2026-11-04", "04 ∫ 11 Mittwoch Bar")).toBe(true);
  });

  test("Erfundenes und Vergangenes fliegt raus, N/A wird kein Hinweis", () => {
    const events = toEvents(raw([
      { date: "2026-11-05", time: "20:00", artists: ["Fred Wesley"], info: "VVK € 34", status: "N/A" },
      { date: "2026-11-14", time: "19:30", artists: ["Grandbrothers"], venue: "im Theater" },
      { date: "2026-11-20", artists: ["Erfundene Band"] }, // Datum steht nicht im Text
      { date: "2026-11-30", artists: ["Taylor Swift"] }, // Künstler steht nicht im Text
      { date: "2026-10-01", artists: ["Fred Wesley"] }, // vorbei
    ]), q, text, "2026-11-03", []);
    expect(events.map((e) => e.artists[0])).toEqual(["Fred Wesley", "Grandbrothers"]);
    expect(events[0]).toMatchObject({ uid: "jazzhaus:2026-11-05:fred-wesley", status: "", city: "Freiburg", venue: "Jazzhaus" });
    expect(events[1]!.venue).toBe("Theater");
  });

  test("Herkunftsland hinter dem Bandnamen fällt weg", () => {
    const [e] = toEvents(raw([{ date: "2026-11-05", artists: ["Wonk Unit UK", "MØNTY CH"] }]), q, "05.11. Wonk Unit UK, MØNTY CH", "2026-11-03", []);
    expect(e!.artists).toEqual(["Wonk Unit", "MØNTY"]);
  });

  test("Programm erkennen, um bei leerer Antwort nachzufragen", () => {
    expect(looksLikeProgram("04 ∫ 11 Mittwoch\n05 ∫ 11 Donnerstag\n06 ∫ 11 Freitag")).toBe(true);
    expect(looksLikeProgram("Sa, 14. November · So, 15. Nov · Mo 16 novembre")).toBe(true);
    expect(looksLikeProgram("Impressum Kontakt Newsletter")).toBe(false);
  });

  test("lange Seiten werden in Stücke geteilt", () => {
    const parts = chunks(Array.from({ length: 50 }, (_, i) => `Zeile ${i} ${"x".repeat(90)}`).join("\n"), 1000);
    expect(parts.length).toBeGreaterThan(4);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
  });
});

describe("Zusammenführen", () => {
  test("Orte und Länder", () => {
    expect(sameCity("Freiburg im Breisgau", "Freiburg")).toBe(true);
    expect(countryOf("Karlsruhe-Durlach", quellen.orte)).toBe("DE");
    expect(countryOf("Baden", quellen.orte)).toBe("CH");
    expect(countryOf("Baden-Baden", quellen.orte)).toBe("DE");
    expect(countryOf("Stuttgart", quellen.orte)).toBeNull();
  });

  test("derselbe Abend aus zwei Quellen wird einer, die erste Quelle gewinnt", () => {
    const merged = mergeDuplicates([
      event({ uid: "jazzhaus:1", source: "jazzhaus", info: "VVK € 30" }),
      event({ uid: "vaddi:1", source: "vaddi", artists: ["MIGHTY OAKS"], city: "Freiburg im Breisgau", time: "20:00", status: "Ausverkauft" }),
      event({ uid: "vaddi:2", source: "vaddi", artists: ["Ella Stern"], title: "Ella Stern" }),
    ]);
    expect(merged.map((e) => e.uid)).toEqual(["jazzhaus:1", "vaddi:2"]);
    expect(merged[0]).toMatchObject({ info: "VVK € 30", time: "20:00", status: "Ausverkauft" });
    expect(isSameEvent(event({}), event({ date: "2026-12-01" }))).toBe(false);
  });

  test("kommende Termine", () => {
    expect(isUpcoming("2026-11-03", "2026-11-03")).toBe(true);
    expect(isUpcoming("2026-11-02", "2026-11-03")).toBe(false);
    expect(isUpcoming("2026-02-30", "2026-01-01")).toBe(false);
    expect(isUpcoming("2026-13-01", "2026-01-01")).toBe(false);
  });
});

describe("Einzelne Quelle testen", () => {
  test("Teilergebnis ersetzt nur diese Quelle, Dubletten werden neu aufgelöst", () => {
    const kalender = new Kalender({ file: "kalender/quellen.json" } as KalenderConfig, () => "");
    const prev: KalenderResult = {
      at: "t0", dryRun: false, transferredAt: "t0",
      sources: [{ id: "jazzhaus", name: "Jazzhaus", found: 1, sent: 1 }, { id: "vaddi", name: "Vaddi", found: 1, sent: 1 }],
      events: [event({ uid: "jazzhaus:1", source: "jazzhaus" }), event({ uid: "vaddi:x", source: "vaddi", artists: ["Ella Stern"] })],
    };
    const partial: KalenderResult = {
      at: "t1", dryRun: true,
      sources: [{ id: "vaddi", name: "Vaddi", found: 2, sent: 2 }],
      events: [event({ uid: "vaddi:1", source: "vaddi" }), event({ uid: "vaddi:2", source: "vaddi", artists: ["Bob Dylan"] })],
    };
    const combined = kalender.combine(prev, partial);
    expect(combined.events.map((e) => e.uid)).toEqual(["jazzhaus:1", "vaddi:2"]);
    expect(combined.sources.map((s) => [s.id, s.sent])).toEqual([["jazzhaus", 1], ["vaddi", 1]]);
    expect(combined.dryRun).toBe(true);
  });
});

describe("Abgleich mit WordPress", () => {
  const wp = (over: Partial<WpEvent>): WpEvent => ({
    ...event({}), id: 1, locked: false, post_status: "publish", edit_link: "https://wp.example/edit/1", ...over,
  });

  test("neu, unverändert, geändert und Dublette", () => {
    const existing = [
      wp({ id: 1, uid: "jazzhaus:a", source: "jazzhaus", artists: ["Fred Wesley"], title: "Fred Wesley", date: "2026-11-05" }),
      wp({ id: 2, uid: "jazzhaus:b", source: "jazzhaus", artists: ["Nand"], title: "Nand", date: "2026-11-11", info: "alt" }),
      wp({ id: 3, uid: "manuell:3", source: "manuell", artists: ["Mighty Oaks"], date: "2026-11-30" }),
    ];
    const events = [
      event({ uid: "jazzhaus:a", source: "jazzhaus", artists: ["Fred Wesley"], title: "Fred Wesley", date: "2026-11-05" }),
      event({ uid: "jazzhaus:b", source: "jazzhaus", artists: ["Nand"], title: "Nand", date: "2026-11-11", info: "VVK € 35" }),
      event({ uid: "vaddi:oaks", source: "vaddi", artists: ["MIGHTY OAKS"], date: "2026-11-30" }),
      event({ uid: "vaddi:stern", source: "vaddi", artists: ["Ella Stern"], date: "2026-11-13" }),
    ];
    const a = compare(events, existing, ["jazzhaus", "vaddi"], "2026-11-03");
    expect(a.checks.map((c) => c.state)).toEqual(["unverändert", "geändert", "dublette", "neu"]);
    expect(a.checks[1]!.changes).toEqual(["info"]);
    expect(a.checks[2]!.existing?.id).toBe(3);
    expect(prepare(events, a).map((e) => e.uid)).toEqual(["jazzhaus:a", "jazzhaus:b", "vaddi:stern"]);
  });

  test("leicht anderer Name derselben Quelle aktualisiert den vorhandenen Eintrag", () => {
    const existing = [wp({ id: 7, uid: "jazzhaus:2026-11-05:fred-wesley", source: "jazzhaus", artists: ["Fred Wesley"], date: "2026-11-05" })];
    const events = [event({ uid: "jazzhaus:2026-11-05:fred-wesley-generations", source: "jazzhaus", artists: ["Fred Wesley Generations"], date: "2026-11-05" })];
    const a = compare(events, existing, ["jazzhaus"], "2026-11-03");
    expect(a.checks[0]!.state).toBe("geändert");
    expect(a.removals).toEqual([]);
    expect(prepare(events, a)[0]!.uid).toBe("jazzhaus:2026-11-05:fred-wesley");
  });

  test("Termine einer Quelle, die gerade ersetzt wird, zählen nicht als Dublette – außer gesperrt", () => {
    const old = wp({ id: 4, uid: "vaddi:oaks", source: "vaddi", date: "2026-11-30" });
    const events = [event({ uid: "jazzhaus:oaks", source: "jazzhaus", date: "2026-11-30" })];
    expect(compare(events, [old], ["jazzhaus", "vaddi"], "2026-11-03").checks[0]!.state).toBe("neu");
    expect(compare(events, [{ ...old, locked: true }], ["jazzhaus", "vaddi"], "2026-11-03").checks[0]!.state).toBe("dublette");
    // einzeln übertragen ersetzt keine Quelle – dann bleibt der Vaddi-Eintrag und ist eine Dublette
    expect(compare(events, [old], [], "2026-11-03").checks[0]!.state).toBe("dublette");
  });

  test("was wegfiele und was in WordPress schon doppelt ist", () => {
    const existing = [
      wp({ id: 1, uid: "vaddi:weg", source: "vaddi", artists: ["Abgesagt"], date: "2026-12-01" }),
      wp({ id: 2, uid: "vaddi:alt", source: "vaddi", artists: ["Gestern"], date: "2026-11-02" }),
      wp({ id: 3, uid: "vaddi:fest", source: "vaddi", artists: ["Gesperrt"], date: "2026-12-02", locked: true }),
      wp({ id: 4, uid: "manuell:4", source: "manuell", artists: ["Mighty Oaks"], date: "2026-11-30" }),
      wp({ id: 5, uid: "jazzhaus:oaks", source: "jazzhaus", artists: ["Mighty Oaks"], date: "2026-11-30" }),
    ];
    const a = compare([], existing, ["vaddi"], "2026-11-03");
    expect(a.removals.map((r) => r.id)).toEqual([1]);
    expect(a.wpDuplicates.map(([x, y]) => [x.id, y.id])).toEqual([[4, 5]]);
  });
});

describe("Abbrechen", () => {
  test("stoppt eine hängende Seite sofort, fertige Quellen bleiben, übertragen wird nichts", async () => {
    // Seite, die nie antwortet – wie ein Sprachmodell, das sehr lange rechnet
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    const dir = mkdtempSync(join(tmpdir(), "kalender-"));
    const file = join(dir, "quellen.json");
    const seite = (id: string) => ({ typ: "seite", id, name: id, url: `http://127.0.0.1:${server.port}/${id}`, location: id, ort: "Freiburg", land: "DE" });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(await Bun.file("kalender/quellen.json").text()), quellen: [seite("a"), seite("b")] }));
    const kalender = new Kalender({ file, timezone: "Europe/Berlin", llm: {} } as KalenderConfig, () => "");

    const started = Date.now();
    const running = kalender.run({ dryRun: false });
    await Bun.sleep(100);
    expect(kalender.cancel()).toBe(true);
    const result = await running;
    server.stop(true);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.cancelled).toBe(true);
    expect(result.sources).toEqual([]); // die abgebrochene Quelle zählt nicht, b wurde nicht mehr angefangen
    expect(result.transferredAt).toBeUndefined();
    expect(kalender.busy).toBe(false);
    expect(kalender.cancel()).toBe(false);
  });
});
