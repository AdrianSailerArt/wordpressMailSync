/**
 * regioactive.de: Veranstaltungsportal für Südbaden, in das Veranstalter ihre Termine selbst eintragen.
 * Für Locations ohne eigenes Programm (z. B. nur Facebook) – die Location-Seite hat für jeden Termin
 * einen festen Block mit Titel, Detail-Link, Beginn (ISO) und Kategorie.
 */

import { convert } from "html-to-text";
import { fetchText, isExcluded, type KonzertEvent, type Quelle, type Quellen } from "./events.ts";

type Regioactive = Extract<Quelle, { typ: "regioactive" }>;

const text = (html: string) => convert(html, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }] }).replace(/\s+/g, " ").trim();

// Kategorien, die keine Musik sind (regioactive nennt sie unter jedem Termin)
const NOT_MUSIC = /^(comedy|kabarett|theater|lesung|vortrag|kinder|ausstellung|film|kino|sport|markt|workshop|führung)/i;

export function parseRegioactive(html: string, q: Regioactive): KonzertEvent[] {
  const events: KonzertEvent[] = [];
  for (const block of html.split(/<div class="preview clickdiv/).slice(1)) {
    const start = block.match(/<time datetime="(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    const link = block.match(/<a href="(\/(?:konzert|party|festival|event|veranstaltung)[^"]*)"/)?.[1] ?? block.match(/<a href="(\/[^"]+)"/)?.[1];
    const title = text(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
    if (!start || !title) continue;
    const category = text(block.match(/<div class="mt-3 text-sm text-gray-500">([\s\S]*?)<\/div>/)?.[1] ?? "");
    if (NOT_MUSIC.test(category)) continue;
    const teaser = text(block.match(/<div class="text-sm mt-3 text-gray-800">([\s\S]*?)<a class="more/)?.[1] ?? "").replace(/\s*\.\.\.$/, " …");
    // „Onkelznacht /Mehlsack“ – den Ort hinter dem Schrägstrich braucht es nicht
    const name = title.replace(new RegExp(`\\s*/\\s*${q.location}\\s*$`, "i"), "").trim();
    // regioactive-Id am Ende des Links bleibt stabil, auch wenn der Titel geändert wird
    const id = link?.match(/-([A-Za-z0-9]{8,})$/)?.[1] ?? `${start[1]}-${name}`;
    // „00:00“ heißt bei regioactive: keine Uhrzeit angegeben
    const time = start[2] === "00:00" ? "" : start[2];
    events.push({
      uid: `${q.id}:${id}`,
      source: q.id,
      date: start[1],
      time,
      // „Muggeseggel (Death-Metal) + Bitterness (Thrash)“ → zwei Künstler ohne Genre-Klammern
      artists: name.split(/\s+\+\s+/).map((a) => a.replace(/\s*\([^)]*\)\s*/g, " ").trim()).filter(Boolean),
      title: name,
      venue: q.location,
      city: q.ort,
      country: q.land,
      info: [category, teaser].filter(Boolean).join(" · ").slice(0, 300),
      url: link ? new URL(link, "https://www.regioactive.de").toString() : q.url,
      status: /abgesagt|cancel/i.test(title) ? "Abgesagt" : /ausverkauft|sold out/i.test(title) ? "Ausverkauft" : "",
    });
  }
  return events;
}

export async function fetchRegioactive(q: Regioactive, today: string, quellen: Quellen, abort?: AbortSignal): Promise<KonzertEvent[]> {
  return parseRegioactive(await fetchText(q.url, abort), q).filter((e) => e.date >= today && !isExcluded(`${e.title} ${e.info}`, quellen.ausschliessen));
}
