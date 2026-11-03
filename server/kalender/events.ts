/** Konzertkalender: Termin-Format, Quellenliste und die Regeln fürs Filtern und Zusammenführen. */

import { readFileSync } from "node:fs";
import { z } from "zod";

/** Ein Termin, wie ihn das WordPress-Plugin „Konzertkalender“ erwartet. */
export interface KonzertEvent {
  /** stabil je Quelle, damit ein Termin beim nächsten Abruf aktualisiert statt doppelt angelegt wird */
  uid: string;
  source: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM oder leer
  artists: string[];
  title: string;
  venue: string;
  city: string;
  country: string; // DE, CH, FR …
  /** Freitext: Tourname, Preis, Einlass, Support … */
  info: string;
  url: string;
  /** z. B. „Ausverkauft“, „Verschoben“, „Abgesagt“ */
  status: string;
}

const Gebiet = z.object({ name: z.string(), lat: z.number(), lon: z.number(), radiusKm: z.number() });

const Quelle = z.discriminatedUnion("typ", [
  z.object({ typ: z.literal("vaddi"), id: z.string(), name: z.string(), url: z.string().url() }),
  z.object({ typ: z.literal("z7"), id: z.string(), name: z.string(), url: z.string().url() }),
  z.object({ typ: z.literal("ticketmaster"), id: z.string(), name: z.string() }),
  // beliebige Veranstalter-Seite, das Sprachmodell liest die Termine heraus
  z.object({
    typ: z.literal("seite"), id: z.string(), name: z.string(), url: z.string().url(),
    location: z.string(), ort: z.string(), land: z.string().length(2),
  }),
]);

export const QuellenSchema = z.object({
  /** Kreise für die Ticketmaster-Suche */
  gebiet: z.array(Gebiet).min(1),
  /** Orte → Land; Veranstalter mit Terminen in ganz Deutschland (Vaddi) werden darauf beschränkt */
  orte: z.record(z.string(), z.string().length(2)),
  /** Stichworte in Titel oder Untertitel, die keine Musik sind (Comedy, Lesung …) */
  ausschliessen: z.array(z.string()).default([]),
  quellen: z.array(Quelle).min(1),
});

export type Quellen = z.infer<typeof QuellenSchema>;
export type Quelle = z.infer<typeof Quelle>;
export type Gebiet = z.infer<typeof Gebiet>;

export const loadQuellen = (path: string): Quellen => QuellenSchema.parse(JSON.parse(readFileSync(path, "utf8")));

/** Kleinbuchstaben, ohne Akzente und Satzzeichen – zum Vergleichen von Namen. */
export const normalize = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ").trim();

/** „Freiburg im Breisgau“ und „Karlsruhe-Durlach“ gehören zu „Freiburg“ und „Karlsruhe“. */
export function sameCity(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
}

/** Land eines Orts laut Quellenliste, oder null, wenn der Ort nicht im Gebiet liegt. */
export function countryOf(city: string, orte: Quellen["orte"]): string | null {
  // genau gleich vor ähnlich, dann der längste Name: „Baden“ (Aargau) ≠ „Baden-Baden“
  const exact = Object.entries(orte).find(([ort]) => normalize(ort) === normalize(city));
  const match = exact ?? Object.entries(orte).filter(([ort]) => sameCity(city, ort)).sort(([a], [b]) => b.length - a.length)[0];
  return match?.[1] ?? null;
}

export function isExcluded(text: string, keywords: string[]): boolean {
  const t = normalize(text);
  return keywords.some((k) => new RegExp(`\\b${normalize(k)}`).test(t));
}

/** Entfernung in km (Haversine). */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const inGebiet = (p: { lat: number; lon: number }, gebiet: Gebiet[]) => gebiet.some((g) => distanceKm(p, g) <= g.radiusKm);

/** Stabiler Teil der uid aus Datum und Künstler. */
export const eventKey = (date: string, name: string) => `${date}:${normalize(name).replace(/ /g, "-").slice(0, 60)}`;

/** Termin liegt zwischen heute und in `days` Tagen. */
export function isUpcoming(date: string, today: string, days = 730): boolean {
  // Date.parse nimmt auch den 30. Februar – deshalb hin und zurück vergleichen
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  const max = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return date >= today && date <= max;
}

const sameArtist = (a: string, b: string) => {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
};

/** Derselbe Abend am selben Ort mit mindestens einem gemeinsamen Künstler. */
export function isSameEvent(a: KonzertEvent, b: KonzertEvent): boolean {
  if (a.date !== b.date || !sameCity(a.city, b.city)) return false;
  const names = (e: KonzertEvent) => (e.artists.length ? e.artists : [e.title]);
  return names(a).some((x) => names(b).some((y) => sameArtist(x, y)));
}

/**
 * Dubletten über Quellen hinweg zusammenführen. Die Reihenfolge entscheidet: Termine früherer Quellen
 * bleiben, spätere ergänzen nur fehlende Angaben (Uhrzeit, Infos, Link, Hinweis) und fallen dann weg.
 */
export function mergeDuplicates(events: KonzertEvent[]): KonzertEvent[] {
  const kept: KonzertEvent[] = [];
  const byDay = new Map<string, KonzertEvent[]>();
  for (const e of events) {
    const day = byDay.get(e.date) ?? [];
    const twin = day.find((k) => k.source !== e.source && isSameEvent(k, e));
    if (twin) {
      twin.time ||= e.time;
      twin.info ||= e.info;
      twin.url ||= e.url;
      twin.status ||= e.status;
      continue;
    }
    const copy = { ...e, artists: [...e.artists] };
    day.push(copy);
    byDay.set(e.date, day);
    kept.push(copy);
  }
  return kept;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

/** `abort`: Abbruch von außen (Abbrechen-Knopf), zusätzlich zum Zeitlimit */
export const withTimeout = (ms: number, abort?: AbortSignal) =>
  abort ? AbortSignal.any([abort, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

export async function fetchText(url: string, abort?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" },
    signal: withTimeout(30_000, abort),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}
