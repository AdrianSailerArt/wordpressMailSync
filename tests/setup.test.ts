import { afterEach, describe, expect, test } from "bun:test";
import type { Config } from "../server/config.ts";
import { Store } from "../server/db.ts";
import { applySetup, envDefaults, importEnv, loadSetup, mergeSetup, publicSetup, testWordPress } from "../server/setup.ts";

const config = (): Config => ({
  imap: { accounts: [], maxAgeDays: 7 },
  wp: { url: "https://env.example", user: "env", appPassword: "env-pw", status: "publish", categories: ["News"], categorySlugs: {}, seoPlugin: "none", featuredImage: true },
  limits: { perRun: 1, timezone: "Europe/Berlin", suggestSchedule: "" },
  llm: { provider: "ollama", siteName: "Env-Blog", siteTone: "locker", claudeKey: false, openaiKey: "" } as Config["llm"],
  server: { host: "", port: 0, password: "", dbPath: ":memory:", dataDir: "data" },
});

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("Einrichtung", () => {
  test("Geheimnisse: leer behält, null löscht, neuer Wert ersetzt", () => {
    const a = mergeSetup({}, { wp: { url: "https://blog.example", appPassword: "eins" }, keys: { openai: "sk-1" } });
    const b = mergeSetup(a, { wp: { appPassword: "", url: "blog.example/" }, keys: { openai: null, anthropic: "sk-ant" } });
    expect(b.wp).toMatchObject({ appPassword: "eins", url: "https://blog.example" });
    expect(b.keys).toEqual({ anthropic: "sk-ant", openai: undefined, ticketmaster: undefined });
  });

  test("überschreibt die .env an Ort und Stelle – Kategorien-Array bleibt dasselbe Objekt", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const cfg = config();
    const kal = { ticketmasterKey: "", postStatus: "publish" as const, auto: false, schedule: "30 6 * * *", timezone: "Europe/Berlin" };
    const defaults = envDefaults(cfg, "");
    const cats = cfg.wp.categories;
    applySetup(cfg, kal, mergeSetup({}, {
      site: { name: "Bühnenblog" }, wp: { url: "https://neu.example", categories: "News=music-news,Events" },
      keys: { anthropic: "sk-ant", ticketmaster: "tm" },
    }), defaults);
    expect(cfg.llm.siteName).toBe("Bühnenblog");
    expect(cfg.llm.siteTone).toBe("locker");
    // andere Adresse als in der .env: deren Passwort gilt hier nicht
    expect(cfg.wp).toMatchObject({ url: "https://neu.example", user: "env", appPassword: "", categorySlugs: { News: "music-news" } });
    expect(cats).toBe(cfg.wp.categories);
    expect(cats).toEqual(["News", "Events"]);
    expect(cfg.llm.claudeKey).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY as string | undefined).toBe("sk-ant");
    expect(kal.ticketmasterKey).toBe("tm");

    // Key gelöscht → zurück auf den Stand der .env (hier: keiner)
    applySetup(cfg, kal, mergeSetup({}, {}), defaults);
    expect(cfg.llm.claudeKey).toBe(false);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.wp.url).toBe("https://env.example");
  });

  test("öffnet sich von selbst, solange WordPress oder Postfach fehlen – bis „fertig“", () => {
    const cfg = config();
    expect(publicSetup(cfg, null, {}, 1).needed).toBe(false);
    expect(publicSetup(cfg, null, {}, 0).needed).toBe(true);
    cfg.wp.appPassword = "";
    expect(publicSetup(cfg, null, {}, 1).needed).toBe(true);
    expect(publicSetup(cfg, null, { done: true }, 0).needed).toBe(false);
  });

  test("ans Dashboard ohne Geheimnisse", () => {
    const json = JSON.stringify(publicSetup(config(), { ticketmasterKey: "tm-geheim", postStatus: "publish", auto: false, schedule: "30 6 * * *", timezone: "Europe/Berlin" }, {}, 1));
    expect(json).not.toContain("env-pw");
    expect(json).not.toContain("tm-geheim");
    expect(json).toContain('"ticketmaster":true');
  });

  test("WordPress-Test meldet fehlende Angaben, ohne etwas abzurufen", async () => {
    expect((await testWordPress({ url: "", user: "", appPassword: "" })).error).toContain("ausfüllen");
  });
});

describe("Passwörter wandern nicht zu einem anderen Zugang", () => {
  test("neue WordPress-Adresse ohne neues Passwort: kein Passwort", () => {
    const a = mergeSetup({}, { wp: { url: "https://alt.example", user: "bot", appPassword: "geheim" } });
    expect(mergeSetup(a, { wp: { url: "https://neu.example" } }).wp?.appPassword).toBeUndefined();
    expect(mergeSetup(a, { wp: { url: "alt.example/" } }).wp?.appPassword).toBe("geheim");
  });

  test("Passwort aus der .env gilt nur für den Zugang aus der .env", () => {
    const cfg = config();
    const defaults = envDefaults(cfg, "");
    applySetup(cfg, null, mergeSetup({}, { wp: { url: "https://anders.example" } }), defaults);
    expect(cfg.wp.appPassword).toBe("");
    applySetup(cfg, null, mergeSetup({}, {}), defaults);
    expect(cfg.wp.appPassword).toBe("env-pw");
  });
});

describe(".env einmal übernehmen", () => {
  const vars = { SITE_NAME: "Env-Blog", POSTS_PER_RUN: "5", AUTO_PUBLISH: "true", SCHEDULE: "0 8 * * *", KALENDER_AUTO: "ja", DASHBOARD_PASSWORD: "pw", OLLAMA_MODEL: "gemma4", LLM_PROVIDER: "mlx" };
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("alles Gesetzte landet typgerecht in der Datenbank – genau einmal", () => {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const store = new Store(":memory:");
    store.setSetting("setup", JSON.stringify({ site: { name: "schon gespeichert" } }));
    expect(importEnv(store)).toBe(true);
    const data = loadSetup(store);
    expect(data.site?.name).toBe("schon gespeichert");
    expect(data.limits).toEqual({ perRun: 5 });
    // automatisches Veröffentlichen aus alten .env-Dateien wird nicht übernommen
    expect(JSON.stringify(data)).not.toContain("autoPublish");
    expect(data.kalender?.auto).toBe(true);
    expect(data.server?.password).toBe("pw");
    expect(store.getSetting("ollama_model")).toBe("gemma4");
    expect(store.getSetting("llm_provider")).toBe("mlx");

    process.env.POSTS_PER_RUN = "9";
    expect(importEnv(store)).toBe(false);
    expect(loadSetup(store).limits?.perRun).toBe(5);
  });
});

describe("Eingaben prüfen", () => {
  test("Zeitpläne, Zeitzone, Zahlen und Adressen mit lesbarer Meldung", () => {
    expect(() => mergeSetup({}, { limits: { suggestSchedule: "jeden Morgen" } })).toThrow("Vorschläge: kein gültiger Zeitplan");
    expect(() => mergeSetup({}, { limits: { timezone: "Mars/Olympus" } })).toThrow("Zeitzone");
    expect(() => mergeSetup({}, { limits: { perRun: 0 } })).toThrow("Entwürfe pro Testlauf");
    expect(() => mergeSetup({}, { llm: { ollamaUrl: "localhost:11434" } })).toThrow("Ollama");
    expect(mergeSetup({}, { llm: { ollamaUrl: "http://127.0.0.1:11434/" }, limits: { suggestSchedule: "0 9 * * 1-5" } })).toMatchObject({
      llm: { ollamaUrl: "http://127.0.0.1:11434" }, limits: { suggestSchedule: "0 9 * * 1-5" },
    });
  });

  test("Dashboard-Passwort: leer behält, null schaltet ab", () => {
    const a = mergeSetup({}, { server: { password: "geheim", port: 3300 } });
    expect(mergeSetup(a, { server: { password: "" } }).server).toMatchObject({ password: "geheim", port: 3300 });
    expect(mergeSetup(a, { server: { password: null } }).server?.password).toBeUndefined();
  });

  test("alte Einträge zum automatischen Veröffentlichen bleiben wirkungslos", () => {
    const cfg = config();
    applySetup(cfg, null, { limits: { autoPublish: true, schedule: "* * * * *", daily: 99 } } as never, envDefaults(cfg, ""));
    expect(Object.keys(cfg.limits).sort()).toEqual(["perRun", "suggestSchedule", "timezone"]);
  });

  test("Limits und Kalender wirken an Ort und Stelle, ohne Geheimnisse nach außen", () => {
    const cfg = config();
    const kal = { ticketmasterKey: "", postStatus: "publish" as const, auto: false, schedule: "30 6 * * *", timezone: "Europe/Berlin" };
    const limits = cfg.limits;
    applySetup(cfg, kal, mergeSetup({}, { limits: { perRun: 2, timezone: "Europe/Zurich" }, kalender: { auto: true, status: "draft" }, server: { password: "pw" }, mail: { maxAgeDays: 14 } }), envDefaults(cfg, ""));
    expect(limits).toBe(cfg.limits);
    expect(cfg.limits).toEqual({ perRun: 2, timezone: "Europe/Zurich", suggestSchedule: "" });
    expect(kal).toMatchObject({ auto: true, postStatus: "draft", timezone: "Europe/Zurich" });
    expect(cfg.imap.maxAgeDays).toBe(14);
    expect(cfg.server.password).toBe("pw");
    const pub = JSON.stringify(publicSetup(cfg, kal, {}, 1));
    expect(pub).toContain('"hasPassword":true');
    expect(pub).not.toContain('"pw"');
  });
});
