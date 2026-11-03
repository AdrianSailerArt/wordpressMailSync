/**
 * Ticketmaster Discovery API (kostenlos, 5000 Abrufe/Tag, 5 pro Sekunde): Musik-Termine im Umkreis
 * der Gebiets-Kreise. Schlüssel gibt es nach Registrierung auf developer.ticketmaster.com.
 */

import { inGebiet, isExcluded, withTimeout, type Gebiet, type KonzertEvent } from "./events.ts";

const API = "https://app.ticketmaster.com/discovery/v2/events.json";
const PAGE_SIZE = 200;
// Ticketmaster liefert höchstens 1000 Treffer je Suche (size × page)
const MAX_PAGES = 5;

/** Geohash – Ticketmaster sucht per `geoPoint` (das ältere `latlong` ist veraltet). */
export function geohash(lat: number, lon: number, precision = 7): string {
  const chars = "0123456789bcdefghjkmnpqrstuvwxyz";
  const range = { lat: [-90, 90], lon: [-180, 180] } as Record<"lat" | "lon", [number, number]>;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    const [key, value] = even ? (["lon", lon] as const) : (["lat", lat] as const);
    const r = range[key];
    const mid = (r[0] + r[1]) / 2;
    if (value >= mid) {
      ch = (ch << 1) | 1;
      r[0] = mid;
    } else {
      ch <<= 1;
      r[1] = mid;
    }
    even = !even;
    if (++bit === 5) {
      hash += chars[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export interface TmEvent {
  id: string;
  name: string;
  url?: string;
  dates?: { start?: { localDate?: string; localTime?: string; noSpecificTime?: boolean; timeTBA?: boolean }; status?: { code?: string } };
  priceRanges?: { min?: number; max?: number; currency?: string }[];
  _embedded?: {
    venues?: { name?: string; city?: { name?: string }; country?: { countryCode?: string }; location?: { latitude?: string; longitude?: string } }[];
    attractions?: { name?: string }[];
  };
}

const STATUS: Record<string, string> = { cancelled: "Abgesagt", postponed: "Verschoben", rescheduled: "Neuer Termin" };

// Parkplätze, VIP-Pakete und Gutscheine stehen bei Ticketmaster als eigene „Events“ drin
const NOT_A_CONCERT = /\b(parken|parking|parkplatz|vip[- ]?(package|paket|upgrade)|upgrade|gutschein|voucher|shuttle)\b/i;

export function mapTicketmaster(e: TmEvent, gebiet: Gebiet[], ausschliessen: string[]): KonzertEvent | null {
  const start = e.dates?.start;
  const venue = e._embedded?.venues?.[0];
  if (!start?.localDate || !venue || NOT_A_CONCERT.test(e.name) || isExcluded(e.name, ausschliessen)) return null;
  const lat = Number(venue.location?.latitude);
  const lon = Number(venue.location?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && !inGebiet({ lat, lon }, gebiet)) return null;
  const price = e.priceRanges?.find((p) => typeof p.min === "number");
  const fmt = (n: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: price?.currency || "EUR" }).format(n);
  const artists = (e._embedded?.attractions ?? []).map((a) => a.name?.trim() ?? "").filter(Boolean);
  return {
    uid: `ticketmaster:${e.id}`,
    source: "ticketmaster",
    date: start.localDate,
    time: start.noSpecificTime || start.timeTBA ? "" : (start.localTime ?? "").slice(0, 5),
    artists: artists.length ? artists : [e.name],
    title: e.name,
    venue: venue.name ?? "",
    city: venue.city?.name ?? "",
    country: venue.country?.countryCode ?? "",
    info: price?.min ? `Tickets ab ${fmt(price.min)}` : "",
    url: e.url ?? "",
    status: STATUS[e.dates?.status?.code ?? ""] ?? "",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchTicketmaster(key: string, gebiet: Gebiet[], ausschliessen: string[], abort?: AbortSignal): Promise<KonzertEvent[]> {
  const found = new Map<string, KonzertEvent>();
  for (const g of gebiet) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(API);
      Object.entries({
        apikey: key, geoPoint: geohash(g.lat, g.lon), radius: String(g.radiusKm), unit: "km",
        classificationName: "music", size: String(PAGE_SIZE), page: String(page), sort: "date,asc", locale: "*",
      }).forEach(([k, v]) => url.searchParams.set(k, v));
      const res = await fetch(url, { signal: withTimeout(30_000, abort) });
      if (res.status === 429) throw new Error("Ticketmaster: Tageskontingent erschöpft (429)");
      if (!res.ok) throw new Error(`Ticketmaster ${g.name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { _embedded?: { events?: TmEvent[] }; page?: { totalPages?: number } };
      for (const e of body._embedded?.events ?? []) {
        const mapped = mapTicketmaster(e, gebiet, ausschliessen);
        if (mapped) found.set(mapped.uid, mapped);
      }
      await sleep(250); // höchstens 5 Abrufe pro Sekunde
      if (page + 1 >= (body.page?.totalPages ?? 0)) break;
    }
  }
  return [...found.values()];
}
