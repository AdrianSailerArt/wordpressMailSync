/**
 * Locations im Dashboard pflegen: Quellen vom Typ „seite“ und „regioactive“ in der Quellenliste
 * anlegen, ändern und löschen. Die Datei bleibt im gewohnten, von Hand lesbaren Format.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { QuellenSchema, normalize, type Quelle, type Quellen } from "./events.ts";

export const LocationInput = z.object({
  name: z.string().trim().min(1, "Name fehlt"),
  url: z.string().trim().url("Keine gültige Adresse (mit https://)"),
  /** so heißt die Location in den Terminen – leer: wie der Name */
  location: z.string().trim().default(""),
  ort: z.string().trim().min(1, "Ort fehlt"),
  land: z.string().trim().toUpperCase().length(2, "Land als Kürzel, z. B. DE"),
});
export type LocationInput = z.input<typeof LocationInput>;

type Location = Extract<Quelle, { typ: "seite" | "regioactive" }>;
const isLocation = (q: Quelle): q is Location => q.typ === "seite" || q.typ === "regioactive";

/** Seiten auf regioactive.de liest ein fester Parser, alles andere das Sprachmodell. */
export const typFor = (url: string): Location["typ"] => (/(^|\.)regioactive\.de$/i.test(new URL(url).hostname) ? "regioactive" : "seite");

/** „Café Atlantik“ → „cafe-atlantik“, eindeutig gegenüber den vorhandenen Quellen */
export function newId(name: string, taken: string[]): string {
  const base = normalize(name).replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "location";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function toQuelle(input: LocationInput, id: string): Location {
  const parsed = LocationInput.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(" · "));
  const l = parsed.data;
  if (typFor(l.url) === "regioactive" && !new URL(l.url).pathname.startsWith("/location/"))
    throw new Error("Bei regioactive.de die Location-Seite nehmen (regioactive.de/location/…)");
  return { typ: typFor(l.url), id, name: l.name, url: l.url, location: l.location || l.name, ort: l.ort, land: l.land };
}

/** neuer Ort landet auch in „orte“, damit Veranstalter wie Vaddi ihn dem Gebiet zuordnen */
function withOrt(q: Quellen, l: Location): Quellen {
  return l.ort in q.orte ? q : { ...q, orte: { ...q.orte, [l.ort]: l.land } };
}

export function addLocation(q: Quellen, input: LocationInput): { quellen: Quellen; quelle: Location } {
  const draft = toQuelle(input, "");
  const quelle = { ...draft, id: newId(draft.name, q.quellen.map((x) => x.id)) };
  if (q.quellen.some((x) => "url" in x && x.url.replace(/\/$/, "") === quelle.url.replace(/\/$/, "")))
    throw new Error(`${quelle.url} ist schon als Quelle eingetragen`);
  // vor Vaddi, Z7 und Ticketmaster einsortieren: frühere Quellen gewinnen bei Dubletten
  const firstOther = q.quellen.findIndex((x) => !isLocation(x));
  const quellen = [...q.quellen];
  quellen.splice(firstOther === -1 ? quellen.length : firstOther, 0, quelle);
  return { quellen: withOrt({ ...q, quellen }, quelle), quelle };
}

/** Die id bleibt: an ihr hängen die schon übertragenen Termine in WordPress. */
export function updateLocation(q: Quellen, id: string, input: LocationInput): { quellen: Quellen; quelle: Location } {
  const i = q.quellen.findIndex((x) => x.id === id);
  if (i === -1) throw new Error(`Quelle „${id}“ gibt es nicht`);
  if (!isLocation(q.quellen[i]!)) throw new Error(`„${q.quellen[i]!.name}“ hat einen festen Parser und lässt sich hier nicht bearbeiten`);
  const quelle = toQuelle(input, id);
  const quellen = q.quellen.map((x, n) => (n === i ? quelle : x));
  return { quellen: withOrt({ ...q, quellen }, quelle), quelle };
}

export function removeLocation(q: Quellen, id: string): Quellen {
  const quelle = q.quellen.find((x) => x.id === id);
  if (!quelle) throw new Error(`Quelle „${id}“ gibt es nicht`);
  if (!isLocation(quelle)) throw new Error(`„${quelle.name}“ hat einen festen Parser und lässt sich hier nicht löschen`);
  return { ...q, quellen: q.quellen.filter((x) => x.id !== id) };
}

const Ort = z.object({
  name: z.string().trim().min(1, "Ort fehlt"),
  land: z.string().trim().toUpperCase().length(2, "Land als Kürzel, z. B. DE"),
});

/** Ort fürs Gebiet eintragen oder sein Land ändern – Groß-/Kleinschreibung eines vorhandenen Orts bleibt */
export function setOrt(q: Quellen, input: { name: string; land: string }): Quellen {
  const parsed = Ort.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(" · "));
  const { name, land } = parsed.data;
  const existing = Object.keys(q.orte).find((o) => normalize(o) === normalize(name)) ?? name;
  return { ...q, orte: { ...q.orte, [existing]: land } };
}

/** Ort entfernen – nicht, solange eine Location dort liegt */
export function removeOrt(q: Quellen, name: string): Quellen {
  if (!(name in q.orte)) throw new Error(`Ort „${name}“ gibt es nicht`);
  const users = q.quellen.filter((x) => "ort" in x && x.ort === name).map((x) => x.name);
  if (users.length) throw new Error(`„${name}“ wird noch von ${users.join(", ")} genutzt`);
  const { [name]: _, ...orte } = q.orte;
  return { ...q, orte };
}

/** Wie die Datei von Hand gepflegt wird: eine Quelle pro Zeile, Orte in Zeilen zu sechst. */
export function formatQuellen(q: Quellen): string {
  const line = (v: unknown) => JSON.stringify(v).replace(/^\{/, "{ ").replace(/\}$/, " }").replace(/":/g, '": ').replace(/,"/g, ', "');
  const orte = Object.entries(q.orte).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const orteLines: string[] = [];
  for (let i = 0; i < orte.length; i += 6) orteLines.push(`    ${orte.slice(i, i + 6).join(", ")}`);
  return [
    "{",
    `  "gebiet": [\n${q.gebiet.map((g) => `    ${line(g)}`).join(",\n")}\n  ],`,
    `  "orte": {\n${orteLines.join(",\n")}\n  },`,
    `  "ausschliessen": ${JSON.stringify(q.ausschliessen).replace(/","/g, '", "')},`,
    `  "quellen": [\n${q.quellen.map((x) => `    ${line(x)}`).join(",\n")}\n  ]`,
    "}",
    "",
  ].join("\n");
}

/** Datei lesen, ändern, prüfen und atomar zurückschreiben */
export function editQuellen<T>(path: string, change: (q: Quellen) => { quellen: Quellen; result: T }): T {
  const { quellen, result } = change(QuellenSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
  QuellenSchema.parse(quellen);
  writeFileSync(`${path}.tmp`, formatQuellen(quellen));
  renameSync(`${path}.tmp`, path);
  return result;
}
