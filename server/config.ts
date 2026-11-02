/** Konfiguration aus Umgebungsvariablen (Bun lädt .env automatisch). */

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Fehlende Konfiguration: ${name} (siehe .env.example)`);
}

const bool = (name: string, fallback: boolean) =>
  ["1", "true", "yes", "ja"].includes(env(name, String(fallback)).toLowerCase());

export type SeoPlugin = "yoast" | "rankmath" | "none";

export function loadConfig() {
  return {
    imap: {
      host: env("IMAP_HOST"),
      port: Number(env("IMAP_PORT", "993")),
      user: env("IMAP_USER"),
      password: env("IMAP_PASSWORD"),
      folder: env("IMAP_FOLDER", "INBOX"),
      processedFolder: env("IMAP_PROCESSED_FOLDER", ""),
      maxAgeDays: Number(env("MAX_AGE_DAYS", "7")),
    },
    wp: {
      url: env("WP_URL").replace(/\/+$/, ""),
      user: env("WP_USER"),
      appPassword: env("WP_APP_PASSWORD"),
      status: env("WP_STATUS", "publish") as "publish" | "draft" | "pending",
      categories: env("WP_CATEGORIES", "News").split(",").map((c) => c.trim()).filter(Boolean),
      seoPlugin: env("SEO_PLUGIN", "none").toLowerCase() as SeoPlugin,
      featuredImage: bool("FEATURED_IMAGE", true),
    },
    limits: {
      daily: Number(env("DAILY_LIMIT", "3")),
      perRun: Number(env("POSTS_PER_RUN", "1")),
      timezone: env("TIMEZONE", "Europe/Berlin"),
      schedule: env("SCHEDULE", "0 8,13,18 * * *"),
    },
    claude: {
      model: env("CLAUDE_MODEL", "claude-opus-5-5"),
      siteName: env("SITE_NAME", "Musikblog"),
      siteTone: env("SITE_TONE", "locker und kompetent"),
    },
    server: {
      host: env("HOST", "127.0.0.1"),
      port: Number(env("PORT", "3000")),
      password: env("DASHBOARD_PASSWORD", ""),
      dbPath: env("DB_PATH", "data/pressbot.sqlite"),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
