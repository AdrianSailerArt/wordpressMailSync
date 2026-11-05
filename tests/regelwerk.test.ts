import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db.ts";
import { Regelwerk } from "../server/regelwerk.ts";
import { styleGuideFor } from "../server/rewrite.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(template = "# Regeln\n\n## Stimme\n\n- Wir duzen.\n") {
  const dir = mkdtempSync(join(tmpdir(), "regelwerk-"));
  dirs.push(dir);
  const file = join(dir, "regelwerk.md");
  writeFileSync(file, template);
  return { file, r: new Regelwerk(new Store(":memory:"), file) };
}

test("ohne eigene Fassung gilt die Vorlage", () => {
  const { r } = setup();
  expect(r.current()).toContain("Wir duzen");
  expect(r.state()).toMatchObject({ custom: false, updatedAt: null });
});

test("eigene Fassung gilt – die Datei bleibt unverändert als Vorlage", () => {
  const { file, r } = setup();
  const s = r.save("# Regeln\r\n\r\n- Wir siezen nie.\r\n");
  expect(s.custom).toBe(true);
  expect(s.updatedAt).not.toBeNull();
  expect(r.current()).toBe("# Regeln\n\n- Wir siezen nie.\n");
  expect(readFileSync(file, "utf8")).toContain("Wir duzen");
  expect(s.template).toContain("Wir duzen");
});

test("zurücksetzen – und Speichern der unveränderten Vorlage – nimmt wieder die Vorlage", () => {
  const { r } = setup();
  r.save("anders");
  expect(r.reset()).toMatchObject({ custom: false });
  expect(r.current()).toContain("Wir duzen");
  r.save("anders");
  expect(r.save(r.template() + "\n\n").custom).toBe(false);
});

test("zu lang wird abgelehnt", () => {
  expect(() => setup().r.save("x".repeat(200_001))).toThrow("zu lang");
});

test("Aufbau-Abschnitte nur für die passende Meldungsart", () => {
  const text = "## Stimme\n- a\n\n## Aufbau nach Art der Meldung\n- Hinweis\n\n## Aufbau: Tour (tour)\n- T\n\n## Aufbau: Album (album)\n- A\n";
  const tour = styleGuideFor(text, "tour");
  expect(tour).toContain("- T");
  expect(tour).not.toContain("- A");
  expect(tour).not.toContain("Hinweis");
  expect(styleGuideFor("", "tour")).toBe("");
});
