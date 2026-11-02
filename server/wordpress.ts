/** WordPress-REST-API: Tageslimit prüfen, Beitrag samt Bild, Tags und SEO-Meta anlegen. */

import type { Config } from "./config.ts";
import type { ImageAttachment } from "./mail.ts";
import type { Article } from "./rewrite.ts";

const SEO_META_KEYS = {
  yoast: { title: "_yoast_wpseo_title", description: "_yoast_wpseo_metadesc", keyword: "_yoast_wpseo_focuskw" },
  rankmath: { title: "rank_math_title", description: "rank_math_description", keyword: "rank_math_focus_keyword" },
} as const;

const ALL_STATUSES = "publish,future,draft,pending";

/** Heutiges Datum in der Zeitzone, z. B. "2026-11-02". */
export const localDate = (timezone: string, date = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(date);

export class WordPress {
  private api: string;
  private auth: string;
  private me?: number;

  constructor(private cfg: Config["wp"], private timezone: string) {
    this.api = `${cfg.url}/wp-json/wp/v2`;
    this.auth = "Basic " + Buffer.from(`${cfg.user}:${cfg.appPassword.replace(/\s+/g, "")}`).toString("base64");
  }

  private async req(method: string, path: string, init: { query?: Record<string, string | number>; json?: unknown; body?: Uint8Array | string; headers?: Record<string, string> } = {}) {
    const url = new URL(`${this.api}/${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: this.auth, "User-Agent": "wordpress-mail-sync/0.2", ...init.headers };
    let body: Uint8Array | string | undefined = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`WordPress ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  private async userId(): Promise<number> {
    this.me ??= ((await (await this.req("GET", "users/me")).json()) as { id: number }).id;
    return this.me;
  }

  /** Anzahl der heute (lokale Zeitzone) vom Bot-Benutzer angelegten Beiträge. */
  async postsToday(): Promise<number> {
    const res = await this.req("GET", "posts", {
      query: {
        author: await this.userId(),
        // ohne Offset interpretiert WordPress das Datum in der Zeitzone der Website
        after: `${localDate(this.timezone)}T00:00:00`,
        per_page: 1, status: ALL_STATUSES, context: "edit", _fields: "id",
      },
    });
    return Number(res.headers.get("X-WP-Total") ?? 0);
  }

  async slugExists(slug: string): Promise<boolean> {
    const res = await this.req("GET", "posts", { query: { slug, status: ALL_STATUSES, context: "edit", _fields: "id" } });
    return ((await res.json()) as unknown[]).length > 0;
  }

  private async termId(taxonomy: "categories" | "tags", name: string): Promise<number> {
    const found = (await (await this.req("GET", taxonomy, { query: { search: name, per_page: 20, _fields: "id,name" } })).json()) as { id: number; name: string }[];
    const match = found.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (match) return match.id;
    return ((await (await this.req("POST", taxonomy, { json: { name } })).json()) as { id: number }).id;
  }

  private async uploadImage(image: ImageAttachment, alt: string, caption: string): Promise<number> {
    const filename = image.filename.replace(/[^\w.-]+/g, "_");
    const res = await this.req("POST", "media", {
      body: new Uint8Array(image.data),
      headers: { "Content-Type": image.contentType, "Content-Disposition": `attachment; filename="${filename}"` },
    });
    const { id } = (await res.json()) as { id: number };
    await this.req("POST", `media/${id}`, { json: { alt_text: alt, caption } });
    return id;
  }

  async createPost(article: Article, image?: ImageAttachment): Promise<{ id: number; link: string }> {
    const payload: Record<string, unknown> = {
      title: article.title,
      slug: article.slug,
      content: article.content_html,
      excerpt: article.excerpt,
      status: this.cfg.status,
      categories: [await this.termId("categories", article.category)],
      tags: await Promise.all(article.tags.map((t) => this.termId("tags", t))),
    };
    const keys = this.cfg.seoPlugin === "none" ? undefined : SEO_META_KEYS[this.cfg.seoPlugin];
    if (keys) {
      payload.meta = {
        [keys.title]: article.title,
        [keys.description]: article.meta_description,
        [keys.keyword]: article.focus_keyword,
      };
    }
    if (image) {
      const caption = article.image_credit ? `Foto: ${article.image_credit}` : "";
      payload.featured_media = await this.uploadImage(image, article.title, caption);
    }
    return (await (await this.req("POST", "posts", { json: payload })).json()) as { id: number; link: string };
  }
}
