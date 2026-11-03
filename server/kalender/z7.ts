/** Konzertfabrik Z7 (Pratteln): die Startseite enthält den ganzen Kalender, Beginn und Preis stehen auf der Detailseite. */

import { convert } from "html-to-text";
import { fetchText, isExcluded, type KonzertEvent, type Quellen } from "./events.ts";

const text = (html: string) => convert(html, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }] }).replace(/\s+/g, " ").trim();

/** Alle Termine des Kalenders auf der Startseite. */
export function parseZ7(html: string): KonzertEvent[] {
  const events: KonzertEvent[] = [];
  for (const block of html.split(/<article\b/).slice(1)) {
    const date = block.match(/<time datetime="(\d{4}-\d{2}-\d{2})"/)?.[1];
    const url = block.match(/<a href="(https:\/\/z-7\.ch\/event\/[^"]+)"/)?.[1];
    const headliner = text(block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "");
    if (!date || !url || !headliner) continue;
    // darunter entweder die Support-Bands (h4, mit · getrennt) oder ein Untertitel (p)
    const support = block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/)?.[1];
    const subtitle = support ? "" : text(block.match(/<\/h2>\s*<div[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
    const badges = [...block.matchAll(/<span class="inline-flex[^"]*">([\s\S]*?)<\/span>/g)].map((m) => text(m[1]!)).filter(Boolean);
    events.push({
      uid: `z7:${url.replace(/^https:\/\/z-7\.ch\/event\//, "").replace(/\/$/, "")}`,
      source: "z7",
      date,
      time: "",
      artists: [headliner, ...(support ? text(support).split(/\s*·\s*/).filter(Boolean) : [])],
      title: subtitle ? `${headliner} – ${subtitle}` : headliner,
      venue: "Konzertfabrik Z7",
      city: "Pratteln",
      country: "CH",
      info: subtitle,
      url,
      status: badges.join(", "),
    });
  }
  return events;
}

/** Beginn, Einlass und Preis von der Detailseite (WooCommerce/FooEvents). */
export function parseZ7Detail(html: string): { time: string; info: string } {
  const field = (label: string) => html.match(new RegExp(`<b>${label}:\\s*</b>\\s*(\\d{1,2}:\\d{2})`))?.[1]?.padStart(5, "0") ?? "";
  const price = text(html.match(/<p class="price">([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/\s+/g, " ");
  const doors = field("Einlass");
  return { time: field("Beginn"), info: [doors && `Einlass ${doors}`, price && `Tickets ${price}`].filter(Boolean).join(" · ") };
}

export async function fetchZ7(url: string, today: string, quellen: Quellen, abort?: AbortSignal): Promise<KonzertEvent[]> {
  const events = parseZ7(await fetchText(url, abort)).filter((e) => e.date >= today && !isExcluded(e.title, quellen.ausschliessen));
  // Detailseiten zu viert gleichzeitig – höflich, aber schnell
  const queue = [...events];
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      abort?.throwIfAborted();
      // Detailseite nicht erreichbar → Termin ohne Uhrzeit und Preis behalten
      const detail = await fetchText(e.url, abort).then(parseZ7Detail, () => null);
      if (!detail) continue;
      e.time = detail.time;
      e.info = [e.info, detail.info].filter(Boolean).join(" · ");
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return events;
}
