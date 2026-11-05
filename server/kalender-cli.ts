/**
 * Konzertkalender einmalig abrufen und ans WordPress-Plugin schicken.
 *   bun run kalender                     alle Quellen
 *   bun run kalender --dry-run           nur anzeigen, nichts übertragen
 *   bun run kalender vaddi jazzhaus      nur diese Quellen
 */

import { loadKalenderConfig } from "./config.ts";
import { Store } from "./db.ts";
import { Kalender } from "./kalender/sync.ts";
import { defaultModel } from "./rewrite.ts";
import { loadSetup } from "./setup.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.filter((a) => !a.startsWith("--"));
const cfg = loadKalenderConfig();
// gleicher Zwischenspeicher wie das Dashboard: unveränderte Seitenabschnitte liest das Modell nicht neu
const store = new Store(cfg.dbPath);
// WordPress-Zugang und Ticketmaster-Key aus der Einrichtung im Dashboard gehen vor der .env
const setup = loadSetup(store);
if (setup.wp?.url) cfg.wp = { url: setup.wp.url, user: setup.wp.user ?? "", appPassword: setup.wp.appPassword ?? "" };
if (setup.keys?.ticketmaster) cfg.ticketmasterKey = setup.keys.ticketmaster;
const kalender = new Kalender(cfg, () => defaultModel(cfg.llm), store);

const result = await kalender.run({ dryRun, only, log: (line) => console.log(line) });

if (dryRun) {
  for (const e of result.events) {
    console.log(`${e.date} ${e.time || "     "}  ${e.artists.join(", ") || e.title}  @ ${e.venue}, ${e.city} (${e.country})${e.status ? ` [${e.status}]` : ""}${e.info ? `  – ${e.info}` : ""}  {${e.source}}`);
  }
}
console.log("");
for (const s of result.sources) {
  const wp = s.wp ? ` → ${s.wp.created} neu, ${s.wp.updated} aktualisiert, ${s.wp.deleted} entfernt` : "";
  console.log(`${s.name.padEnd(22)} ${String(s.found).padStart(4)} gefunden, ${String(s.sent).padStart(4)} ohne Dubletten${wp}${s.error || s.sendError ? `  FEHLER: ${s.error || s.sendError}` : ""}${s.skipped ? `  (${s.skipped})` : ""}`);
}
if (result.sources.some((s) => s.error || s.sendError)) process.exitCode = 1;
