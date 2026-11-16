/** WordPress-REST-API: heutige Beiträge zählen, Beitrag samt Bild, Tags und SEO-Meta anlegen. */

import type { Config } from "./config.ts";
import type { VideoInfo } from "./images.ts";
import type { ImageAttachment } from "./mail.ts";
import { slugify, type Article } from "./rewrite.ts";
import { insertAtParagraphs, type ParagraphInsert } from "../shared/paragraphs.ts";

const SEO_META_KEYS = {
  yoast: { title: "_yoast_wpseo_title", description: "_yoast_wpseo_metadesc", keyword: "_yoast_wpseo_focuskw" },
  rankmath: { title: "rank_math_title", description: "rank_math_description", keyword: "rank_math_focus_keyword" },
} as const;

const ALL_STATUSES = "publish,future,draft,pending";

export type WpCategory = {
  id: number;
  name: string;
  slug: string;
  parent: number;
  count: number;
};

/** Bild aus der WordPress-Mediathek, wie es das Dashboard zeigt */
export type WpMedia = {
  id: number;
  /** Originaldatei */
  url: string;
  /** kleine Vorschau (medium/thumbnail), sonst das Original */
  thumb: string;
  title: string;
  alt: string;
  caption: string;
  filename: string;
  width: number;
  height: number;
  date: string;
  /** wie gut das Bild zum Beitrag passt (nur bei Vorschlägen) */
  score?: number;
  /** welche Begriffe gepasst haben */
  matched?: string[];
};

/** Bild für den Beitrag: neu hochladen (aus der Mail) oder vorhandenes aus der Mediathek */
export type PostImage = ImageAttachment | { mediaId: number };

/** Bild im Text an einer bestimmten Stelle: after = nach diesem Absatz (0 = ganz oben) */
export type InlineImage = { image: PostImage; after: number };

/** Videos stehen nach dem zweiten Absatz */
const VIDEO_AFTER = 2;

export const isLibraryImage = (img: PostImage): img is { mediaId: number } => "mediaId" in img;

/** Bild-IDs aus der Mediathek stehen im Entwurf als „wp:123“ – Mail-Bilder haben 12 Hex-Zeichen */
export const MEDIA_PREFIX = "wp:";
export const mediaIdOf = (id: string): number | null => {
  const m = id.match(/^wp:(\d+)$/);
  return m ? Number(m[1]) : null;
};

type RawMedia = {
  id: number;
  date: string;
  source_url: string;
  title?: { rendered?: string; raw?: string };
  alt_text?: string;
  caption?: { rendered?: string; raw?: string };
  media_details?: { width?: number; height?: number; file?: string; sizes?: Record<string, { source_url: string; width: number }> };
};

const MEDIA_FIELDS = "id,date,source_url,title,alt_text,caption,media_details";

/** Heutiges Datum in der Zeitzone, z. B. "2026-11-02". */
export const localDate = (timezone: string, date = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(date);

export class WordPress {
  private me?: number;
  private cats?: { at: number; list: Promise<WpCategory[]> };
  /** Zugang, für den me/cats gelten – ändert ihn die Einrichtung, wird neu geladen */
  private account = "";

  /** limits: daraus die Zeitzone – ändert sie die Einrichtung, gilt das sofort */
  constructor(private cfg: Config["wp"], private limits: { timezone: string }) {}

  private get api() {
    if (!this.cfg.url) throw new Error("WordPress ist noch nicht eingerichtet – Einstellungen → Einrichtung");
    const account = `${this.cfg.url}|${this.cfg.user}`;
    if (account !== this.account) {
      this.account = account;
      this.me = undefined;
      this.cats = undefined;
    }
    return `${this.cfg.url}/wp-json/wp/v2`;
  }

  private get auth() {
    return "Basic " + Buffer.from(`${this.cfg.user}:${this.cfg.appPassword.replace(/\s+/g, "")}`).toString("base64");
  }

  private async req(method: string, path: string, init: { query?: Record<string, string | number>; json?: unknown; body?: Uint8Array | string; headers?: Record<string, string> } = {}) {
    const url = new URL(`${this.api}/${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: this.auth, "User-Agent": "buehnenpost/0.3", ...init.headers };
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
        after: `${localDate(this.limits.timezone)}T00:00:00`,
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
    // Erst exakt über den Slug suchen – die Volltextsuche liefert bei „Metal“ zuerst „Heavy Metal“ & Co.
    const bySlug = (await (await this.req("GET", taxonomy, { query: { slug: slugify(name), _fields: "id" } })).json()) as { id: number }[];
    if (bySlug[0]) return bySlug[0].id;
    const found = (await (await this.req("GET", taxonomy, { query: { search: name, per_page: 100, _fields: "id,name" } })).json()) as { id: number; name: string }[];
    const match = found.find((t) => decodeHtml(t.name).toLowerCase() === name.toLowerCase());
    if (match) return match.id;
    try {
      return ((await (await this.req("POST", taxonomy, { json: { name } })).json()) as { id: number }).id;
    } catch (err) {
      // existiert doch schon (z. B. anderer Slug) – WordPress nennt die ID in der Fehlermeldung
      const id = String(err).match(/"term_id":(\d+)/)?.[1];
      if (id) return Number(id);
      throw err;
    }
  }

  /** Alle Kategorien der Website (10 Minuten zwischengespeichert). */
  categories(): Promise<WpCategory[]> {
    void this.api; // setzt den Zwischenspeicher zurück, wenn sich der Zugang geändert hat
    if (!this.cats || Date.now() - this.cats.at > 600_000) {
      const list = this.loadCategories();
      list.catch(() => (this.cats = undefined));
      this.cats = { at: Date.now(), list };
    }
    return this.cats.list;
  }

  private async loadCategories(): Promise<WpCategory[]> {
    const all: WpCategory[] = [];
    for (let page = 1; ; page++) {
      const res = await this.req("GET", "categories", { query: { per_page: 100, page, orderby: "name", _fields: "id,name,slug,parent,count" } });
      const list = (await res.json()) as WpCategory[];
      all.push(...list.map((c) => ({ ...c, name: decodeHtml(c.name) })));
      if (page >= Number(res.headers.get("X-WP-TotalPages") ?? 1)) return all;
    }
  }

  /**
   * Kategorie über den Slug – Namen wie „News“ gibt es auf vielen Seiten mehrfach. Akzeptiert den
   * Slug selbst (Auswahl im Dashboard) oder eine Modell-Kategorie aus WP_CATEGORIES.
   */
  private async categoryId(labelOrSlug: string): Promise<number> {
    const slug = this.cfg.categorySlugs[labelOrSlug] ?? labelOrSlug;
    const found = (await this.categories()).find((c) => c.slug === slug);
    if (found) return found.id;
    if (this.cfg.categorySlugs[labelOrSlug]) throw new Error(`WordPress-Kategorie mit Slug „${slug}“ nicht gefunden (WP_CATEGORIES prüfen)`);
    return this.termId("categories", labelOrSlug);
  }

  /** Bilder der Mediathek durchsuchen (Titel, Beschreibung, Bildunterschrift), neueste zuerst. */
  async searchMedia(search = "", page = 1, perPage = 24): Promise<{ items: WpMedia[]; total: number; pages: number }> {
    const query: Record<string, string | number> = { media_type: "image", per_page: perPage, page, _fields: MEDIA_FIELDS, orderby: "date", order: "desc" };
    if (search.trim()) query.search = search.trim();
    const res = await this.req("GET", "media", { query });
    return {
      items: ((await res.json()) as RawMedia[]).map(toMedia),
      total: Number(res.headers.get("X-WP-Total") ?? 0),
      pages: Number(res.headers.get("X-WP-TotalPages") ?? 1),
    };
  }

  /** Einzelnes Bild der Mediathek, null wenn es nicht (mehr) existiert. */
  async media(id: number): Promise<WpMedia | null> {
    try {
      return toMedia((await (await this.req("GET", `media/${id}`, { query: { _fields: MEDIA_FIELDS } })).json()) as RawMedia);
    } catch (err) {
      if (/: 404 /.test(String(err))) return null;
      throw err;
    }
  }

  /**
   * Passende Bilder zum Beitrag: sucht nach Tags (meist Band/Künstler), Fokus-Keyword und Titel,
   * führt die Treffer zusammen und sortiert nach Übereinstimmung. Leer, wenn nichts passt.
   */
  async suggestMedia(article: Pick<Article, "title" | "tags" | "focus_keyword">, limit = 12): Promise<WpMedia[]> {
    const terms = mediaTerms(article);
    if (!terms.length) return [];
    const found = new Map<number, WpMedia>();
    const results = await Promise.allSettled(terms.map((t) => this.searchMedia(t, 1, 20)));
    for (const r of results) if (r.status === "fulfilled") for (const m of r.value.items) found.set(m.id, m);
    // war WordPress gar nicht erreichbar, den Fehler zeigen statt „keine Treffer“
    if (results.every((r) => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
    return rankMedia([...found.values()], terms, article.title).slice(0, limit);
  }

  private async uploadImage(image: ImageAttachment, alt: string, caption: string): Promise<{ id: number; url: string }> {
    const filename = image.filename.replace(/[^\w.-]+/g, "_");
    const res = await this.req("POST", "media", {
      body: new Uint8Array(image.data),
      headers: { "Content-Type": image.contentType, "Content-Disposition": `attachment; filename="${filename}"` },
    });
    const { id, source_url } = (await res.json()) as { id: number; source_url: string };
    await this.req("POST", `media/${id}`, { json: { alt_text: alt, caption } });
    return { id, url: source_url };
  }

  async createPost(
    article: Article, featured?: PostImage, inline: InlineImage[] = [],
    videos: { video: VideoInfo; thumbnail: ImageAttachment | null }[] = [],
  ): Promise<{ id: number; link: string }> {
    const caption = article.image_credit ? `Foto: ${article.image_credit}` : "";
    const inserts: ParagraphInsert[] = [];
    for (const { video, thumbnail } of videos) {
      const media = thumbnail ? await this.uploadImage(thumbnail, `Video: ${video.title}`, "") : null;
      inserts.push({ after: VIDEO_AFTER, html: videoHtml(video, media) });
    }
    for (const { image, after } of inline) {
      if (isLibraryImage(image)) {
        // vorhandenes Bild: nicht neu hochladen, Alt-Text und Bildunterschrift aus der Mediathek
        const media = await this.media(image.mediaId);
        if (media) inserts.push({ after, html: figureHtml(media.id, media.url, media.alt || article.title, media.caption) });
        continue;
      }
      const { id, url } = await this.uploadImage(image, article.title, caption);
      inserts.push({ after, html: figureHtml(id, url, article.title, caption) });
    }
    // alle Positionen beziehen sich auf die Absätze des Entwurfs, so wie im Dashboard gewählt
    const content = insertAtParagraphs(article.content_html, inserts);

    const payload: Record<string, unknown> = {
      title: article.title,
      slug: article.slug,
      content,
      excerpt: article.excerpt,
      status: this.cfg.status,
      // Auswahl im Dashboard, sonst die Kategorie des Modells
      categories: [...new Set(await Promise.all((article.wp_categories.length ? article.wp_categories : [article.category]).map((c) => this.categoryId(c))))],
      tags: await Promise.all(article.tags.map((t) => this.termId("tags", t))),
    };
    const keys = this.cfg.seoPlugin === "none" ? undefined : SEO_META_KEYS[this.cfg.seoPlugin];
    if (keys) {
      payload.meta = {
        [keys.title]: article.seo_title || article.title,
        [keys.description]: article.meta_description,
        [keys.keyword]: article.focus_keyword,
      };
    }
    if (featured) payload.featured_media = isLibraryImage(featured) ? featured.mediaId : (await this.uploadImage(featured, article.title, caption)).id;
    return (await (await this.req("POST", "posts", { json: payload })).json()) as { id: number; link: string };
  }
}

const decodeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&#0?39;|&#8217;/g, "'").replace(/&quot;/g, '"');

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const stripTags = (s: string) => decodeHtml(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

const toMedia = (m: RawMedia): WpMedia => {
  const sizes = m.media_details?.sizes ?? {};
  const thumb = sizes.medium_large ?? sizes.medium ?? sizes.thumbnail;
  return {
    id: m.id,
    url: m.source_url,
    thumb: thumb?.source_url ?? m.source_url,
    title: stripTags(m.title?.rendered ?? m.title?.raw ?? ""),
    alt: m.alt_text ?? "",
    caption: stripTags(m.caption?.rendered ?? m.caption?.raw ?? ""),
    filename: (m.media_details?.file ?? m.source_url).split("/").pop() ?? "",
    width: m.media_details?.width ?? 0,
    height: m.media_details?.height ?? 0,
    date: m.date,
  };
};

/** Vergleichbar machen: klein, ohne Akzente, Trennzeichen aus Dateinamen als Leerzeichen */
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[-_.,:;!?/()"'„“”‚‘’]+/g, " ").replace(/\s+/g, " ").trim();

/** Wörter, nach denen allein zu suchen nichts bringt */
const STOPWORDS = new Set(["neues", "neue", "neuer", "album", "single", "tour", "video", "news", "live", "konzert", "konzerte", "song", "ep", "der", "die", "das", "und", "mit", "von", "the", "and"]);

/** Suchbegriffe für die Mediathek: Tags zuerst (meist Band/Künstler), dann Fokus-Keyword; höchstens 6. */
export const mediaTerms = (article: Pick<Article, "title" | "tags" | "focus_keyword">): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...article.tags, article.focus_keyword]) {
    const t = raw.trim();
    const key = norm(t);
    if (key.length < 3 || STOPWORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, 6);
};

/**
 * Treffer bewerten: Begriff kommt in Titel, Alt-Text, Bildunterschrift oder Dateiname vor.
 * Längere Begriffe (Bandnamen aus mehreren Wörtern) zählen mehr; Treffer im Titel des Beitrags ebenso.
 * Bilder ohne einen einzigen passenden Begriff fallen raus.
 */
export const rankMedia = (items: WpMedia[], terms: string[], title = ""): WpMedia[] => {
  const titleNorm = norm(title);
  return items
    .map((m) => {
      const hay = ` ${norm([m.title, m.alt, m.caption, m.filename].join(" "))} `;
      const matched = terms.filter((t) => hay.includes(` ${norm(t)} `));
      const score = matched.reduce((sum, t) => sum + norm(t).split(" ").length + (titleNorm.includes(norm(t)) ? 1 : 0), 0);
      return { ...m, score, matched };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
};

/** Bild im Format des Block-Editors, damit WordPress es wie ein normal eingefügtes Bild behandelt. */
export const figureHtml = (id: number, url: string, alt: string, caption: string): string => {
  const cap = caption ? `<figcaption class="wp-element-caption">${escapeHtml(caption)}</figcaption>` : "";
  return `<!-- wp:image {"id":${id},"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" class="wp-image-${id}"/>${cap}</figure>\n<!-- /wp:image -->`;
};

/** Nach dem n-ten Absatz einfügen; gibt es weniger Absätze, nach dem letzten bzw. ans Ende. */
export const insertAfterParagraph = (html: string, insert: string, n: number): string =>
  insertAtParagraphs(html, [{ after: n, html: insert }]);

/**
 * YouTube cookiefrei: eigenes Vorschaubild aus der Mediathek, verlinkt auf YouTube.
 * Beim Seitenaufruf wird nichts von Google geladen – kein Player, keine Cookies.
 * (Absichtlich keine nackte YouTube-URL: daraus würde Jetpack einen Player machen.)
 */
export const videoHtml = (video: VideoInfo, media: { id: number; url: string } | null): string => {
  const href = escapeHtml(video.url);
  const title = escapeHtml(video.title || "Video");
  const label = `▶ Video auf YouTube ansehen${video.title ? `: „${title}“` : ""}`;
  if (!media) return `<!-- wp:paragraph -->\n<p><a href="${href}" target="_blank" rel="noopener">${label}</a></p>\n<!-- /wp:paragraph -->`;
  return `<!-- wp:image {"id":${media.id},"sizeSlug":"large","linkDestination":"custom","className":"video-preview"} -->\n` +
    `<figure class="wp-block-image size-large video-preview"><a href="${href}" target="_blank" rel="noopener">` +
    `<img src="${escapeHtml(media.url)}" alt="Video: ${title}" class="wp-image-${media.id}"/></a>` +
    `<figcaption class="wp-element-caption"><a href="${href}" target="_blank" rel="noopener">${label}</a></figcaption></figure>\n<!-- /wp:image -->`;
};
