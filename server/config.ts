/**
 * Eingebaute Standardwerte. Die Einstellungen selbst stehen in der Datenbank (setup.ts, accounts.ts);
 * Umgebungsvariablen – etwa aus einer alten .env – werden nur beim ersten Start einmal übernommen.
 * Ausnahmen als Startparameter: DB_PATH, DATA_DIR (und HOST/PORT gehen vor).
 */

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

const bool = (name: string, fallback: boolean) =>
  ["1", "true", "yes", "ja"].includes(env(name, String(fallback)).toLowerCase());

export function parseCategories(value: string): { categories: string[]; categorySlugs: Record<string, string> } {
  const categorySlugs: Record<string, string> = {};
  const categories = value.split(",").map((entry) => {
    const [label, slug] = entry.split("=").map((s) => s.trim());
    if (label && slug) categorySlugs[label] = slug;
    return label ?? "";
  }).filter(Boolean);
  return { categories, categorySlugs };
}

/**
 * Postfächer aus der .env – nur noch für die einmalige Übernahme beim ersten Start (siehe accounts.ts),
 * danach werden sie im Dashboard gepflegt. Das erste über IMAP_*, weitere über IMAP_2_* … (bis 9).
 * Host, Port und Ordner übernehmen weitere Postfächer vom ersten, wenn sie fehlen.
 */
function imapAccounts() {
  if (!process.env.IMAP_HOST?.trim() || !process.env.IMAP_USER?.trim()) return [];
  const first = {
    name: env("IMAP_NAME", process.env.IMAP_USER?.trim() || "Postfach 1"),
    host: env("IMAP_HOST"),
    port: Number(env("IMAP_PORT", "993")),
    user: env("IMAP_USER"),
    password: env("IMAP_PASSWORD"),
    folder: env("IMAP_FOLDER", "INBOX"),
    processedFolder: env("IMAP_PROCESSED_FOLDER", ""),
  };
  const accounts = [first];
  for (let n = 2; n <= 9; n++) {
    const p = `IMAP_${n}_`;
    if (!Object.keys(process.env).some((k) => k.startsWith(p) && process.env[k]?.trim())) continue;
    accounts.push({
      name: env(`${p}NAME`, process.env[`${p}USER`]?.trim() || `Postfach ${n}`),
      host: env(`${p}HOST`, first.host),
      port: Number(env(`${p}PORT`, String(first.port))),
      user: env(`${p}USER`),
      password: env(`${p}PASSWORD`),
      folder: env(`${p}FOLDER`, first.folder),
      processedFolder: env(`${p}PROCESSED_FOLDER`, ""),
    });
  }
  return accounts;
}

export type ImapAccount = ReturnType<typeof imapAccounts>[number];

export type SeoPlugin = "yoast" | "rankmath" | "none";
export const LLM_PROVIDERS = ["ollama", "mlx", "opencode", "openai", "claude"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

function llmConfig(provider: LlmProvider) {
  // API-Keys sind optional – ohne Key ist der Anbieter im Dashboard ausgegraut (Einrichtung → Sprachmodell)
  return {
    provider,
    ollamaUrl: env("OLLAMA_URL", "http://127.0.0.1:11434").replace(/\/+$/, ""),
    ollamaModel: env("OLLAMA_MODEL", "gemma4"),
    // MLX auf Apple Silicon: `mlx_lm.server` mit OpenAI-kompatibler API
    mlxUrl: env("MLX_URL", "http://127.0.0.1:8080").replace(/\/+$/, ""),
    mlxModel: env("MLX_MODEL", "mlx-community/gemma-4-e4b-it-4bit"),
    // OpenCode lokal (`opencode serve --port 4096`) – nutzt die in OpenCode eingerichteten Anbieter
    opencodeUrl: env("OPENCODE_URL", "http://127.0.0.1:4096").replace(/\/+$/, ""),
    opencodeModel: env("OPENCODE_MODEL", "opencode/big-pickle"),
    // ChatGPT über die OpenAI-API (platform.openai.com), abgerechnet nach Tokens
    openaiUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    openaiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    openaiModel: env("OPENAI_MODEL", "gpt-5.4-mini"),
    claudeModel: env("CLAUDE_MODEL", "claude-opus-5-5"),
    // Claude lässt sich im Dashboard nur mit API-Key wählen
    claudeKey: !!process.env.ANTHROPIC_API_KEY?.trim(),
    siteName: env("SITE_NAME", "Musikblog"),
    siteTone: env("SITE_TONE", "locker und kompetent"),
    // Stil-Regelwerk der Redaktion (Markdown) – leer lassen, um keins zu verwenden
    styleFile: env("STYLE_FILE", "stil/regelwerk.md"),
  };
}

/** WordPress ist optional beim Start – die Einrichtung im Dashboard trägt es nach */
export const normalizeWpUrl = (url: string) => url.trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)(?=.)/, "https://");
const wpUrl = () => normalizeWpUrl(env("WP_URL", ""));


export function loadConfig() {
  const provider = env("LLM_PROVIDER", "ollama").toLowerCase() as LlmProvider;
  const config = {
    imap: {
      accounts: imapAccounts(),
      maxAgeDays: Number(env("MAX_AGE_DAYS", "7")),
    },
    wp: {
      url: wpUrl(),
      user: env("WP_USER", ""),
      appPassword: env("WP_APP_PASSWORD", ""),
      status: env("WP_STATUS", "publish") as "publish" | "draft" | "pending",
      // "News=music-news,Events=events": Anzeigename für das Modell = Slug der WordPress-Kategorie
      ...parseCategories(env("WP_CATEGORIES", "News")),
      seoPlugin: env("SEO_PLUGIN", "none").toLowerCase() as SeoPlugin,
      featuredImage: bool("FEATURED_IMAGE", true),
    },
    // Veröffentlicht wird nie automatisch – nur die Freigabe im Dashboard schickt einen Beitrag nach WordPress
    limits: {
      /** Entwürfe pro Testlauf */
      perRun: Number(env("POSTS_PER_RUN", "1")),
      timezone: env("TIMEZONE", "Europe/Berlin"),
      // 10 automatische Vorschläge pro Tag, grob alle 1,5 Stunden
      suggestSchedule: env("SUGGEST_SCHEDULE", "0 8,9,11,12,14,15,17,18,20,21 * * *"),
    },
    llm: llmConfig(provider),
    server: {
      host: env("HOST", "127.0.0.1"),
      port: Number(env("PORT", "3210")),
      password: env("DASHBOARD_PASSWORD", ""),
      dbPath: env("DB_PATH", "data/pressbot.sqlite"),
      dataDir: env("DATA_DIR", "data"),
    },
  };

  return config;
}

export type Config = ReturnType<typeof loadConfig>;

/** Konzertkalender: braucht nur WordPress und das Sprachmodell, kein Postfach. */
export function loadKalenderConfig() {
  const provider = env("LLM_PROVIDER", "ollama").toLowerCase() as LlmProvider;
  const config = {
    wp: { url: wpUrl(), user: env("WP_USER", ""), appPassword: env("WP_APP_PASSWORD", "") },
    llm: llmConfig(provider),
    timezone: env("TIMEZONE", "Europe/Berlin"),
    // Quellen (Veranstalter, Clubs) und Gebiet für Ticketmaster
    file: env("KALENDER_FILE", "kalender/quellen.json"),
    // kostenloser Schlüssel: developer.ticketmaster.com – leer lassen, um Ticketmaster auszulassen
    ticketmasterKey: env("TICKETMASTER_API_KEY", ""),
    // neue Termine sofort zeigen (publish) oder erst prüfen (draft)
    postStatus: env("KALENDER_STATUS", "publish") as "publish" | "draft",
    auto: bool("KALENDER_AUTO", false),
    schedule: env("KALENDER_SCHEDULE", "30 6 * * *"),
    // Zwischenspeicher fürs Sprachmodell liegt in der Datenbank des Dashboards
    dbPath: env("DB_PATH", "data/pressbot.sqlite"),
  };
  return config;
}

export type KalenderConfig = ReturnType<typeof loadKalenderConfig>;
