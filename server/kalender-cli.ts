/**
 * Konzertkalender einmalig abrufen und ans WordPress-Plugin schicken.
 *   bun run kalender                     alle Quellen
 *   bun run kalender --dry-run           nur anzeigen, nichts übertragen
 *   bun run kalender vaddi jazzhaus      nur diese Quellen
 */

import { loadKalenderConfig } from "./config.ts";
import { Kalender } from "./kalender/sync.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.filter((a) => !a.startsWith("--"));
const cfg = loadKalenderConfig();
const kalender = new Kalender(cfg, () => cfg.llm.provider === "claude" ? cfg.llm.claudeModel : cfg.llm.ollamaModel);

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
