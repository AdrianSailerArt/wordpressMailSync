/**
 * Alle Einstellungen im Dashboard statt in der .env: gespeichert in der lokalen Datenbank.
 * Beim ersten Start wird eine vorhandene .env einmal übernommen – danach wird sie nicht mehr gebraucht.
 * Was nicht gespeichert ist, nimmt den eingebauten Standard. Alles ist optional: ohne WordPress lässt
 * sich nichts veröffentlichen, ohne API-Key bleibt der Anbieter ausgegraut.
 * Geheimnisse (App-Passwort, Keys, Dashboard-Passwort) gehen nie ans Dashboard zurück.
 *
 * Nur DB_PATH und DATA_DIR bleiben Startparameter (die Datenbank muss vorher feststehen); HOST und PORT
 * aus der Umgebung gehen vor den gespeicherten Werten, damit sich ein zweiter Server daneben starten lässt.
 */

import { Cron } from "croner";
import { z } from "zod";
import { LLM_PROVIDERS, normalizeWpUrl, parseCategories, type Config, type SeoPlugin } from "./config.ts";
import type { Store } from "./db.ts";

const SETTING = "setup";
const SEO = ["yoast", "rankmath", "none"] as const;

/** null löscht ein gespeichertes Geheimnis, leer/fehlend behält es */
const secret = z.string().trim().nullable().optional();
const cron = z.string().trim().refine((v) => {
  try {
    new Cron(v, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}, "kein gültiger Zeitplan (Cron, z. B. „0 8,13,18 * * *“)").optional();
const timezone = z.string().trim().refine((v) => {
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "unbekannte Zeitzone (z. B. Europe/Berlin)").optional();
const url = z.string().trim().refine((v) => /^https?:\/\/[^\s]+$/.test(v), "Adresse mit http:// oder https://").optional();
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max).optional();

export const SetupInput = z.object({
  site: z.object({ name: z.string().trim().optional(), tone: z.string().trim().optional() }).optional(),
  wp: z.object({
    url: z.string().trim().optional(),
    user: z.string().trim().optional(),
    appPassword: secret,
    /** „News=music-news,Events=events“ */
    categories: z.string().trim().optional(),
    seoPlugin: z.enum(SEO).optional(),
    status: z.enum(["publish", "draft", "pending"]).optional(),
    /** größtes Bild der Mail automatisch als Beitragsbild */
    featuredImage: z.boolean().optional(),
  }).optional(),
  mail: z.object({ maxAgeDays: int(1, 90) }).optional(),
  // kein automatisches Veröffentlichen – nur Vorschläge; freigeben muss immer der Benutzer
  limits: z.object({ perRun: int(1, 20), timezone, suggestSchedule: cron }).optional(),
  llm: z.object({ ollamaUrl: url, mlxUrl: url, opencodeUrl: url, openaiUrl: url, claudeModel: z.string().trim().optional() }).optional(),
  kalender: z.object({ status: z.enum(["publish", "draft"]).optional(), auto: z.boolean().optional(), schedule: cron }).optional(),
  server: z.object({ host: z.string().trim().optional(), port: int(1, 65535), password: secret }).optional(),
  keys: z.object({ anthropic: secret, openai: secret, ticketmaster: secret }).optional(),
  done: z.boolean().optional(),
  /** .env wurde schon übernommen */
  imported: z.boolean().optional(),
});
export type SetupInput = z.input<typeof SetupInput>;
type Stored = z.output<typeof SetupInput>;

export const loadSetup = (store: Store): Stored => JSON.parse(store.getSetting(SETTING) ?? "{}") as Stored;
export const saveSetup = (store: Store, data: Stored) => store.setSetting(SETTING, JSON.stringify(data));

/** Änderungen übernehmen: Felder ersetzen, Geheimnisse nur bei neuem Wert (oder null = löschen) */
export function mergeSetup(old: Stored, input: SetupInput): Stored {
  const parsed = SetupInput.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${LABELS[i.path.join(".")] ?? i.path.join(".")}: ${i.message}`).join(" · "));
  const p = parsed.data;
  const keep = (next: string | null | undefined, prev: string | null | undefined) => (next === null ? undefined : next || prev || undefined);
  const wp = { ...old.wp, ...p.wp };
  if (wp.url) wp.url = normalizeWpUrl(wp.url);
  // anderer Zugang: das alte Passwort gehört nicht dazu
  const sameAccount = wp.url === old.wp?.url && wp.user === old.wp?.user;
  wp.appPassword = keep(p.wp?.appPassword, sameAccount ? old.wp?.appPassword : undefined);
  const llm = { ...old.llm, ...p.llm };
  for (const k of ["ollamaUrl", "mlxUrl", "opencodeUrl", "openaiUrl"] as const) if (llm[k]) llm[k] = llm[k]!.replace(/\/+$/, "");
  return {
    site: { ...old.site, ...p.site },
    wp,
    mail: { ...old.mail, ...p.mail },
    limits: { ...old.limits, ...p.limits },
    llm,
    kalender: { ...old.kalender, ...p.kalender },
    server: { ...old.server, ...p.server, password: keep(p.server?.password, old.server?.password) },
    keys: {
      anthropic: keep(p.keys?.anthropic, old.keys?.anthropic),
      openai: keep(p.keys?.openai, old.keys?.openai),
      ticketmaster: keep(p.keys?.ticketmaster, old.keys?.ticketmaster),
    },
    done: p.done ?? old.done,
    imported: p.imported ?? old.imported,
  };
}

/** Fehlermeldungen mit lesbaren Feldnamen */
const LABELS: Record<string, string> = {
  "limits.suggestSchedule": "Vorschläge", "kalender.schedule": "Konzertkalender",
  "limits.timezone": "Zeitzone", "limits.perRun": "Entwürfe pro Testlauf",
  "mail.maxAgeDays": "Mails der letzten Tage", "server.port": "Port",
  "llm.ollamaUrl": "Ollama", "llm.mlxUrl": "MLX", "llm.opencodeUrl": "OpenCode", "llm.openaiUrl": "OpenAI-Adresse",
};

// ---- .env einmal übernehmen

const bool = (v: string) => ["1", "true", "yes", "ja"].includes(v.toLowerCase());
/** .env-Name → Abschnitt, Feld, Umwandlung */
const ENV: [string, string, string, (v: string) => unknown][] = [
  ["SITE_NAME", "site", "name", String], ["SITE_TONE", "site", "tone", String],
  ["WP_URL", "wp", "url", normalizeWpUrl], ["WP_USER", "wp", "user", String], ["WP_APP_PASSWORD", "wp", "appPassword", String],
  ["WP_CATEGORIES", "wp", "categories", String], ["SEO_PLUGIN", "wp", "seoPlugin", (v) => v.toLowerCase()],
  ["WP_STATUS", "wp", "status", String], ["FEATURED_IMAGE", "wp", "featuredImage", bool],
  ["MAX_AGE_DAYS", "mail", "maxAgeDays", Number],
  // AUTO_PUBLISH, SCHEDULE und DAILY_LIMIT gibt es nicht mehr: veröffentlicht wird nur nach Freigabe
  ["POSTS_PER_RUN", "limits", "perRun", Number], ["TIMEZONE", "limits", "timezone", String],
  ["SUGGEST_SCHEDULE", "limits", "suggestSchedule", String],
  ["OLLAMA_URL", "llm", "ollamaUrl", String], ["MLX_URL", "llm", "mlxUrl", String], ["OPENCODE_URL", "llm", "opencodeUrl", String],
  ["OPENAI_BASE_URL", "llm", "openaiUrl", String], ["CLAUDE_MODEL", "llm", "claudeModel", String],
  ["KALENDER_STATUS", "kalender", "status", String], ["KALENDER_AUTO", "kalender", "auto", bool], ["KALENDER_SCHEDULE", "kalender", "schedule", String],
  ["HOST", "server", "host", String], ["PORT", "server", "port", Number], ["DASHBOARD_PASSWORD", "server", "password", String],
  ["ANTHROPIC_API_KEY", "keys", "anthropic", String], ["OPENAI_API_KEY", "keys", "openai", String], ["TICKETMASTER_API_KEY", "keys", "ticketmaster", String],
];
/** Modell je Anbieter landet bei der Modellwahl des Dashboards */
const ENV_MODELS: [string, string][] = [["OLLAMA_MODEL", "ollama"], ["MLX_MODEL", "mlx"], ["OPENCODE_MODEL", "opencode"], ["OPENAI_MODEL", "openai"]];

/** Werte aus der Umgebung lesen (leere zählen nicht) */
const fromEnv = (name: string) => process.env[name]?.trim() || undefined;

/**
 * Beim ersten Start alles aus der .env übernehmen, was noch nicht gespeichert ist – danach kann sie weg.
 * Gibt zurück, ob etwas übernommen wurde.
 */
export function importEnv(store: Store): boolean {
  const data = loadSetup(store) as Record<string, Record<string, unknown> | boolean | undefined>;
  if (data.imported) return false;
  let any = false;
  for (const [name, section, key, convert] of ENV) {
    const v = fromEnv(name);
    if (v === undefined) continue;
    const s = ((data[section] as Record<string, unknown> | undefined) ??= {});
    if (s[key] === undefined || s[key] === "") {
      s[key] = convert(v);
      any = true;
    }
  }
  const provider = fromEnv("LLM_PROVIDER")?.toLowerCase();
  if (provider && (LLM_PROVIDERS as readonly string[]).includes(provider) && !store.getSetting("llm_provider")) store.setSetting("llm_provider", provider);
  for (const [name, p] of ENV_MODELS) {
    const v = fromEnv(name);
    if (v && !store.getSetting(`${p}_model`)) store.setSetting(`${p}_model`, v);
  }
  data.imported = true;
  saveSetup(store, data as Stored);
  return any;
}

// ---- auf die laufende Konfiguration anwenden

/** Eingebaute Standardwerte (so, wie loadConfig sie ohne .env setzt) */
export interface Defaults {
  siteName: string; siteTone: string;
  wp: { url: string; user: string; appPassword: string; status: Config["wp"]["status"]; seoPlugin: SeoPlugin; categories: string; featuredImage: boolean };
  maxAgeDays: number;
  limits: Omit<Config["limits"], never>;
  llm: Pick<Config["llm"], "ollamaUrl" | "mlxUrl" | "opencodeUrl" | "openaiUrl" | "claudeModel">;
  kalender: { status: "publish" | "draft"; auto: boolean; schedule: string };
  server: { host: string; port: number; password: string };
  anthropic: string; openai: string; ticketmaster: string;
}

/** Stand der Konfiguration beim Start, bevor gespeicherte Werte sie überschreiben */
export function envDefaults(cfg: Config, kalender: { postStatus: "publish" | "draft"; auto: boolean; schedule: string; ticketmasterKey: string } | string): Defaults {
  const kal = typeof kalender === "string" ? { postStatus: "publish" as const, auto: false, schedule: "30 6 * * *", ticketmasterKey: kalender } : kalender;
  return {
    siteName: cfg.llm.siteName,
    siteTone: cfg.llm.siteTone,
    wp: { url: cfg.wp.url, user: cfg.wp.user, appPassword: cfg.wp.appPassword, status: cfg.wp.status, seoPlugin: cfg.wp.seoPlugin, categories: categoriesString(cfg.wp), featuredImage: cfg.wp.featuredImage },
    maxAgeDays: cfg.imap.maxAgeDays,
    limits: { ...cfg.limits },
    llm: { ollamaUrl: cfg.llm.ollamaUrl, mlxUrl: cfg.llm.mlxUrl, opencodeUrl: cfg.llm.opencodeUrl, openaiUrl: cfg.llm.openaiUrl, claudeModel: cfg.llm.claudeModel },
    kalender: { status: kal.postStatus, auto: kal.auto, schedule: kal.schedule },
    server: { host: cfg.server.host, port: cfg.server.port, password: cfg.server.password },
    anthropic: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
    openai: cfg.llm.openaiKey,
    ticketmaster: kal.ticketmasterKey,
  };
}

export const categoriesString = (wp: Pick<Config["wp"], "categories" | "categorySlugs">) =>
  wp.categories.map((c) => (wp.categorySlugs[c] ? `${c}=${wp.categorySlugs[c]}` : c)).join(",");

export type KalenderSettings = { ticketmasterKey: string; postStatus: "publish" | "draft"; auto: boolean; schedule: string; timezone: string };

/**
 * Gespeicherte Einstellungen auf die laufende Konfiguration anwenden. Die Objekte werden an Ort und Stelle
 * geändert, weil WordPress, Rewriter, Postfächer und Kalender sie schon halten – so wirkt alles ohne Neustart.
 */
export function applySetup(cfg: Config, kalender: KalenderSettings | null, data: Stored, d: Defaults) {
  cfg.llm.siteName = data.site?.name || d.siteName;
  cfg.llm.siteTone = data.site?.tone || d.siteTone;

  cfg.wp.url = data.wp?.url || d.wp.url;
  cfg.wp.user = data.wp?.user || d.wp.user;
  // Passwort aus der .env nur für den Zugang aus der .env
  const envAccount = cfg.wp.url === d.wp.url && cfg.wp.user === d.wp.user;
  cfg.wp.appPassword = data.wp?.appPassword || (envAccount ? d.wp.appPassword : "");
  cfg.wp.status = data.wp?.status || d.wp.status;
  cfg.wp.seoPlugin = (data.wp?.seoPlugin || d.wp.seoPlugin) as SeoPlugin;
  cfg.wp.featuredImage = data.wp?.featuredImage ?? d.wp.featuredImage;
  const { categories, categorySlugs } = parseCategories(data.wp?.categories || d.wp.categories || "News");
  cfg.wp.categories.splice(0, cfg.wp.categories.length, ...categories);
  for (const k of Object.keys(cfg.wp.categorySlugs)) delete cfg.wp.categorySlugs[k];
  Object.assign(cfg.wp.categorySlugs, categorySlugs);

  cfg.imap.maxAgeDays = data.mail?.maxAgeDays ?? d.maxAgeDays;
  // nur bekannte Felder – alte Einträge wie autoPublish aus früheren Versionen bleiben wirkungslos
  cfg.limits.perRun = data.limits?.perRun ?? d.limits.perRun;
  cfg.limits.timezone = data.limits?.timezone || d.limits.timezone;
  cfg.limits.suggestSchedule = data.limits?.suggestSchedule || d.limits.suggestSchedule;
  for (const k of ["ollamaUrl", "mlxUrl", "opencodeUrl", "openaiUrl", "claudeModel"] as const) cfg.llm[k] = data.llm?.[k] || d.llm[k];

  // Startparameter aus der Umgebung gehen vor (zweiter Server zum Entwickeln)
  cfg.server.host = fromEnv("HOST") ?? data.server?.host ?? d.server.host;
  cfg.server.port = Number(fromEnv("PORT") ?? data.server?.port ?? d.server.port);
  cfg.server.password = data.server?.password || d.server.password;

  // das Anthropic-SDK liest den Key bei jedem Aufruf aus der Umgebung
  const anthropic = data.keys?.anthropic || d.anthropic;
  if (anthropic) process.env.ANTHROPIC_API_KEY = anthropic;
  else delete process.env.ANTHROPIC_API_KEY;
  cfg.llm.claudeKey = !!anthropic;
  cfg.llm.openaiKey = data.keys?.openai || d.openai;
  if (kalender) {
    kalender.ticketmasterKey = data.keys?.ticketmaster || d.ticketmaster;
    kalender.postStatus = data.kalender?.status || d.kalender.status;
    kalender.auto = data.kalender?.auto ?? d.kalender.auto;
    kalender.schedule = data.kalender?.schedule || d.kalender.schedule;
    kalender.timezone = cfg.limits.timezone;
  }
}

/** Was das Dashboard sieht – ohne Geheimnisse */
export function publicSetup(cfg: Config, kalender: KalenderSettings | null, data: Stored, mailAccounts: number) {
  const wpReady = !!(cfg.wp.url && cfg.wp.user && cfg.wp.appPassword);
  return {
    done: !!data.done,
    /** ohne WordPress oder Postfach geht nichts – dann öffnet sich die Einrichtung von selbst */
    needed: !data.done && (!wpReady || mailAccounts === 0),
    site: { name: cfg.llm.siteName, tone: cfg.llm.siteTone },
    wp: {
      url: cfg.wp.url, user: cfg.wp.user, hasAppPassword: !!cfg.wp.appPassword,
      categories: categoriesString(cfg.wp), seoPlugin: cfg.wp.seoPlugin, status: cfg.wp.status, featuredImage: cfg.wp.featuredImage, ready: wpReady,
    },
    mail: { maxAgeDays: cfg.imap.maxAgeDays },
    limits: { ...cfg.limits },
    llm: { ollamaUrl: cfg.llm.ollamaUrl, mlxUrl: cfg.llm.mlxUrl, opencodeUrl: cfg.llm.opencodeUrl, openaiUrl: cfg.llm.openaiUrl, claudeModel: cfg.llm.claudeModel },
    kalender: kalender ? { status: kalender.postStatus, auto: kalender.auto, schedule: kalender.schedule } : null,
    server: {
      host: cfg.server.host, port: cfg.server.port, hasPassword: !!cfg.server.password,
      /** HOST/PORT aus der Umgebung gehen vor – dann ist das Feld im Dashboard wirkungslos */
      fromEnv: { host: !!fromEnv("HOST"), port: !!fromEnv("PORT") },
    },
    keys: { anthropic: cfg.llm.claudeKey, openai: !!cfg.llm.openaiKey, ticketmaster: !!kalender?.ticketmasterKey },
    mailAccounts,
  };
}
export type PublicSetup = ReturnType<typeof publicSetup>;

// ---- WordPress-Zugang prüfen

export interface WpTest {
  ok: boolean;
  error?: string;
  /** angemeldeter Benutzer */
  name?: string;
  /** darf Beiträge veröffentlichen und Bilder hochladen */
  canPublish?: boolean;
  categories: { name: string; slug: string; count: number }[];
  /** erkanntes SEO-Plugin */
  seoPlugin?: SeoPlugin;
  /** Plugin „Konzertkalender“ aktiv */
  kalender?: boolean;
}

/** Anmelden, Rechte, Kategorien und Plugins abfragen – verändert nichts an der Website */
export async function testWordPress(input: { url: string; user: string; appPassword: string }): Promise<WpTest> {
  const url = normalizeWpUrl(input.url);
  const fail = (error: string): WpTest => ({ ok: false, error, categories: [] });
  if (!url || !input.user || !input.appPassword) return fail("Adresse, Benutzer und Anwendungspasswort ausfüllen");
  const headers = {
    Authorization: "Basic " + Buffer.from(`${input.user}:${input.appPassword.replace(/\s+/g, "")}`).toString("base64"),
    "User-Agent": "buehnenpost/0.3",
  };
  const get = (path: string) => fetch(`${url}/wp-json/${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  try {
    const root = await get("");
    if (!root.ok) return fail(`${url} antwortet nicht wie eine WordPress-Website (REST-API: ${root.status})`);
    const namespaces = ((await root.json()) as { namespaces?: string[] }).namespaces ?? [];
    const me = await get("wp/v2/users/me?context=edit&_fields=name,capabilities");
    if (me.status === 401 || me.status === 403)
      return fail("Anmeldung abgelehnt – Benutzername und Anwendungspasswort prüfen (nicht das normale Login-Passwort)");
    if (!me.ok) return fail(`Anmeldung fehlgeschlagen: ${me.status}`);
    const user = (await me.json()) as { name: string; capabilities?: Record<string, boolean> };
    const cats = await get("wp/v2/categories?per_page=100&orderby=count&order=desc&_fields=name,slug,count");
    const categories = cats.ok ? ((await cats.json()) as WpTest["categories"]) : [];
    return {
      ok: true,
      name: user.name,
      canPublish: !!(user.capabilities?.publish_posts && user.capabilities?.upload_files),
      categories,
      seoPlugin: namespaces.includes("yoast/v1") ? "yoast" : namespaces.some((n) => n.startsWith("rankmath")) ? "rankmath" : "none",
      kalender: namespaces.includes("konzertkalender/v1"),
    };
  } catch (e) {
    const err = e as Error & { code?: string };
    return fail(err.name === "TimeoutError" ? `${url} antwortet nicht` : err.code === "ConnectionRefused" || /resolve|ENOTFOUND|getaddrinfo/i.test(err.message) ? `${url} nicht erreichbar` : err.message);
  }
}
