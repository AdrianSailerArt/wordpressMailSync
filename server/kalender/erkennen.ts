/**
 * Neue Location prüfen, bevor sie gespeichert wird: Wie lässt sich die Seite lesen, stehen dort Termine,
 * und was lässt sich für Name, Ort und Land vorschlagen? Ruft die Seite ab, fragt aber kein Sprachmodell.
 */

import { fetchText, normalize, type Quellen } from "./events.ts";
import { parseRegioactive } from "./regioactive.ts";
import { countDates, pageText } from "./seite.ts";

export interface Erkennung {
  /** so würde die Seite gelesen */
  typ: "seite" | "regioactive";
  /** gut: Termine gefunden · unsicher: kaum Termine · ungeeignet: so nicht lesbar */
  urteil: "gut" | "unsicher" | "ungeeignet";
  hinweis: string;
  /** gefundene Termine (regioactive) bzw. Datumsangaben im Text (Sprachmodell) */
  termine: number;
  vorschlag: { name?: string; ort?: string; land?: string };
  /** Unterseiten, die nach Programm aussehen – falls die Adresse nur die Startseite ist */
  programmLinks: { text: string; url: string }[];
}

/** Veranstalter mit eigenem, festen Parser – die gibt es nur einmal */
const FESTE: [RegExp, string][] = [
  [/(^|\.)z-7\.ch$/i, "Konzertfabrik Z7"],
  [/(^|\.)vaddi-concerts\.de$/i, "Vaddi Concerts"],
];

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

const meta = (html: string, prop: string) =>
  html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)`, "i"))?.[1]
  ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i"))?.[1];

/** „Programm | Jazzhaus Freiburg“ → „Jazzhaus Freiburg“: der Teil, der kein Seitentitel wie „Programm“ ist */
export function nameFrom(html: string): string | undefined {
  const site = meta(html, "og:site_name");
  if (site) return decode(site);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const parts = title.split(/\s+[|–—·-]\s+/).map((p) => p.trim()).filter(Boolean);
  const generic = /^(home|startseite|programm|veranstaltungen|termine|events?|konzerte|kalender|agenda|willkommen)\b/i;
  return parts.find((p) => !generic.test(p)) ?? parts[0] ?? undefined;
}

/** Ort und Land: erst aus schema.org-Angaben, dann über Postleitzahl + Ort im Text, bekannte Orte bevorzugt */
export function ortFrom(html: string, text: string, orte: Quellen["orte"]): { ort?: string; land?: string } {
  const known = (name: string) => Object.keys(orte).find((o) => normalize(o) === normalize(name));
  const locality = html.match(/"addressLocality"\s*:\s*"([^"]+)"/)?.[1];
  const country = html.match(/"addressCountry"\s*:\s*(?:\{[^}]*"name"\s*:\s*)?"([A-Za-z]{2})"/)?.[1]?.toUpperCase();
  if (locality) {
    const ort = known(decode(locality)) ?? decode(locality);
    return { ort, land: orte[ort] ?? country };
  }
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/\b(?:(?:D|CH|F)-)?\d{4,5}\s+([A-ZÄÖÜ][a-zäöüß]+(?:[- ][A-ZÄÖÜ][a-zäöüß]+)?)/g)) {
    const ort = known(m[1]!) ?? known(m[1]!.split(/[- ]/)[0]!);
    if (ort) counts.set(ort, (counts.get(ort) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? { ort: best, land: orte[best] } : {};
}

/** Links wie „Programm“, „Konzerte“, „Veranstaltungen“ auf derselben Website */
export function programmLinks(html: string, base: string): { text: string; url: string }[] {
  // „/programm“ und „/programm.html“ sind dieselbe Seite
  const key = (u: string) => u.replace(/(\.html?|\/)$/i, "");
  const seen = new Set<string>([key(base)]);
  const links: { text: string; url: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decode(m[2]!);
    if (!/^(programm|spielplan|veranstaltungen|termine|konzerte|events?|agenda|kalender|calendar|tickets?)\b/i.test(text) || text.length > 40) continue;
    let url: URL;
    try {
      url = new URL(m[1]!, base);
    } catch {
      continue;
    }
    if (url.hostname !== new URL(base).hostname) continue;
    if (seen.has(key(url.toString()))) continue;
    seen.add(key(url.toString()));
    links.push({ text, url: url.toString() });
  }
  return links.slice(0, 4);
}

/** regioactive.de/location/emmendingen-mundingen/… → bekannter Ort „Emmendingen“ */
function regioOrt(url: URL, orte: Quellen["orte"]): { ort?: string; land?: string } {
  const slug = url.pathname.split("/")[2] ?? "";
  const words = slug.split("-");
  for (let n = words.length; n > 0; n--) {
    const candidate = words.slice(0, n).join(" ");
    const ort = Object.keys(orte).find((o) => normalize(o) === normalize(candidate));
    if (ort) return { ort, land: orte[ort] };
  }
  return slug ? { ort: words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("-"), land: "DE" } : {};
}

/** Seite einordnen – rein aus dem HTML, ohne Netz (zum Testen) */
export function einordnen(url: string, html: string, orte: Quellen["orte"]): Erkennung {
  const u = new URL(url);
  if (/(^|\.)regioactive\.de$/i.test(u.hostname)) {
    const base: Erkennung = { typ: "regioactive", urteil: "gut", hinweis: "", termine: 0, vorschlag: {}, programmLinks: [] };
    if (!u.pathname.startsWith("/location/"))
      return { ...base, urteil: "ungeeignet", hinweis: "Bitte die Location-Seite auf regioactive.de nehmen – die Adresse beginnt mit regioactive.de/location/…" };
    const h1 = decode(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
    const vorschlag = { name: h1 || undefined, ...regioOrt(u, orte) };
    const termine = parseRegioactive(html, { typ: "regioactive", id: "test", name: h1, url, location: h1, ort: "", land: "DE" }).length;
    return termine
      ? { ...base, termine, vorschlag, hinweis: "Der feste Parser für regioactive.de liest die Termine." }
      : { ...base, urteil: "unsicher", termine, vorschlag, hinweis: "Fester Parser für regioactive.de – gerade stehen dort keine Musik-Termine. Das kann sich ändern." };
  }

  const text = pageText(html);
  const base: Erkennung = {
    typ: "seite", urteil: "gut", hinweis: "", termine: 0,
    // Adresse steht meist im Footer – den lässt pageText weg, also den ganzen Text nehmen
    vorschlag: { name: nameFrom(html), ...ortFrom(html, decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")), orte) },
    programmLinks: programmLinks(html, url),
  };
  if (text.length < 200)
    return { ...base, urteil: "ungeeignet", hinweis: "Die Seite enthält kaum Text – sie lädt ihre Termine wohl per JavaScript nach. Steht die Location auf regioactive.de, nimm besser deren Location-Seite." };
  const termine = countDates(text);
  if (termine >= 3) return { ...base, termine, hinweis: "Das Sprachmodell liest die Termine aus dem Seitentext." };
  return {
    ...base, urteil: "unsicher", termine,
    hinweis: base.programmLinks.length
      ? "Kaum Datumsangaben – ist das die Programm-Seite? Eine der Unterseiten unten passt vermutlich besser."
      : "Kaum Datumsangaben – ist das die Seite mit dem Programm? Das Sprachmodell findet hier vermutlich nichts.",
  };
}

/** Seite abrufen und einordnen – `ausser`: die gerade bearbeitete Quelle zählt nicht als schon eingetragen */
export async function erkennen(url: string, quellen: Quellen, ausser?: string): Promise<Erkennung> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Keine gültige Adresse (mit https://)");
  }
  const fest = FESTE.find(([re]) => re.test(u.hostname));
  if (fest) {
    const vorhanden = quellen.quellen.some((q) => q.name === fest[1]);
    return {
      typ: "seite", urteil: "ungeeignet", termine: 0, vorschlag: {}, programmLinks: [],
      hinweis: `${fest[1]} hat einen eigenen, festen Parser${vorhanden ? " und ist schon als Quelle eingetragen" : ""} – nicht als Location anlegen.`,
    };
  }
  const same = (a: string) => a.replace(/\/$/, "") === u.toString().replace(/\/$/, "");
  const doppelt = quellen.quellen.find((q) => q.id !== ausser && "url" in q && same(q.url));
  if (doppelt)
    return { typ: "seite", urteil: "ungeeignet", termine: 0, vorschlag: {}, programmLinks: [], hinweis: `Diese Adresse ist schon als „${doppelt.name}“ eingetragen.` };
  let html: string;
  try {
    html = await fetchText(u.toString());
  } catch (e) {
    return {
      typ: /(^|\.)regioactive\.de$/i.test(u.hostname) ? "regioactive" : "seite", urteil: "ungeeignet", termine: 0, vorschlag: {}, programmLinks: [],
      hinweis: `Seite nicht erreichbar: ${(e as Error).message}`,
    };
  }
  return einordnen(u.toString(), html, quellen.orte);
}
