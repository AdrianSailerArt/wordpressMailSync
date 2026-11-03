/** Vaddi Concerts (Freiburg): die Programmseite listet alle Termine mit festen CSS-Klassen. */

import { convert } from "html-to-text";
import { countryOf, fetchText, isExcluded, normalize, type KonzertEvent, type Quellen } from "./events.ts";

const text = (html: string) => convert(html, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }] }).replace(/\s+/g, " ").trim();

/** Inhalt des ersten Elements mit dieser Klasse (bis zum nächsten schließenden div/span/h2). */
const byClass = (block: string, cls: string) =>
  block.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</(?:div|span|h2|p)>`))?.[1] ?? "";

/** Alle Termine der Seite, ungefiltert. */
export function parseVaddi(html: string, baseUrl: string): KonzertEvent[] {
  const events: KonzertEvent[] = [];
  for (const block of html.split(/<div class="event">/).slice(1)) {
    const date = block.match(/elweekdaywrap[\s\S]*?(\d{2})\.(\d{2})\.(\d{4})/);
    const artist = text(block.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? "");
    if (!date || !artist) continue;
    const href = block.match(/class="ellink elinfolink" href="([^"]+)"/)?.[1] ?? "";
    // „Ort: Freiburg, Jazzhaus“, manchmal „Ort: Karlsruhe; Schloss“
    const [city = "", ...venue] = text(byClass(block, "ellocationwrap")).replace(/^Ort:\s*/, "").split(/[,;]/).map((s) => s.trim());
    const subtitle = text(block.match(/class="text">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/^\/\/\s*/, "");
    const status = [...block.matchAll(/class="elinfo [^"]*">([\s\S]*?)<\/span>/g)].map((m) => text(m[1]!)).filter(Boolean).join(", ");
    const url = href ? new URL(href, baseUrl).toString() : baseUrl;
    events.push({
      uid: `vaddi:${href || `${date[3]}-${date[2]}-${date[1]}:${artist}`}`,
      source: "vaddi",
      date: `${date[3]}-${date[2]}-${date[1]}`,
      time: text(byClass(block, "elstarttime")).match(/\d{1,2}:\d{2}/)?.[0]?.padStart(5, "0") ?? "",
      artists: [artist],
      title: subtitle ? `${artist} – ${subtitle}` : artist,
      venue: venue.join(", "),
      city,
      country: "DE",
      info: subtitle,
      url,
      status,
    });
  }
  return events;
}

/** Nur Termine im Gebiet und ohne Comedy & Co. (nach Titel). */
export function filterVaddi(events: KonzertEvent[], quellen: Quellen): KonzertEvent[] {
  return events.flatMap((e) => {
    const country = countryOf(e.city, quellen.orte);
    if (!country || isExcluded(e.title, quellen.ausschliessen)) return [];
    return [{ ...e, country }];
  });
}

/** Beschreibung auf der Detailseite – nur dort steht, ob es Comedy, Lesung oder Musik ist. */
export const parseDescription = (html: string) =>
  text(html.match(/class="edtext eddescription">([\s\S]*?)<\/div>/)?.[1] ?? "").slice(0, 3000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MUSIC = /\b(album|alben|songs?|single|band|konzert\w*|musik\w*|musiker\w*|sanger\w*|rapper\w*|rap|hip ?hop|pop|rock|jazz|indie|punk|metal|elektro\w*|techno|dj|orchester|gitarr\w*|chart\w*|hits?|setlist|platte|ep|lieder|liedermacher\w*|schlager|blasmusik|brass|sound|tracks?|streams?)\b/g;
const STAGE = /\b(comedy|comedian\w*|kabarett\w*|humor\w*|lach\w*|pointe\w*|satir\w*|programm|soloprogramm|live programm|buhnenprogramm|buhnenshow|stand ?up|lesung|liest|buch|roman|autor\w*|zauber\w*|ballett|hundeprofi|vortrag)\b/g;

/** Musik oder Bühnenprogramm? Zählt Begriffe in der Beschreibung – Comedy-Texte nennen selten das Wort „Comedy“. */
export function looksLikeMusic(description: string): boolean {
  const t = normalize(description);
  const music = t.match(MUSIC)?.length ?? 0;
  const stage = t.match(STAGE)?.length ?? 0;
  return music >= stage;
}

export async function fetchVaddi(url: string, today: string, quellen: Quellen, abort?: AbortSignal): Promise<KonzertEvent[]> {
  const events = filterVaddi(parseVaddi(await fetchText(url, abort), url), quellen).filter((e) => e.date >= today);
  const kept: KonzertEvent[] = [];
  for (const e of events) {
    abort?.throwIfAborted();
    // Detailseite nicht erreichbar → Termin lieber behalten als verlieren
    const description = e.url !== url ? await fetchText(e.url, abort).then(parseDescription, () => "") : "";
    if (!isExcluded(description, quellen.ausschliessen) && looksLikeMusic(description)) kept.push(e);
    await sleep(150);
  }
  return kept;
}
