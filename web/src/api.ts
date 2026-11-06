/** Typisierter Zugriff auf die REST-API des Servers. */

export interface Article {
  relevant: boolean;
  reason: string;
  title: string;
  seo_title: string;
  slug: string;
  focus_keyword: string;
  meta_description: string;
  excerpt: string;
  content_html: string;
  category: string;
  /** Kategorie-Slugs aus WordPress; leer = Kategorie des Modells */
  wp_categories: string[];
  tags: string[];
  image_credit: string;
  /** "" = automatisch (größtes Bild), "none" = kein Beitragsbild, sonst Bild-ID */
  featured_image: string;
  inline_images: string[];
  generated_by: string;
  /** fehlt = automatisch das erste Video, [] = keins, sonst gewählte YouTube-IDs */
  videos?: string[];
  /** false = News ohne Musikbezug (z. B. Gaming) – darf veröffentlicht werden, mit Warnung */
  music?: boolean;
  /** warum kein Musikbezug */
  music_note?: string;
}

export interface WpCategory {
  id: number;
  name: string;
  slug: string;
  parent: number;
  count: number;
}

export interface WpCategories {
  categories: WpCategory[];
  /** Modell-Kategorie (WP_CATEGORIES) → Slug */
  defaults: Record<string, string>;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  url: string;
}

export interface LlmModel {
  name: string;
  sizeGB: number;
  params: string;
  quantization: string;
  family: string;
  loaded: boolean;
  tooBig: boolean;
}

export type LlmProvider = "ollama" | "mlx" | "opencode" | "openai" | "claude";

export interface ModelsResponse {
  /** Anbieter, dessen Modelle gelistet sind */
  provider: LlmProvider;
  /** Anbieter, der gerade schreibt */
  active: LlmProvider;
  activeModel: string;
  /** gewähltes Modell des gelisteten Anbieters */
  current: string;
  providers: { id: LlmProvider; label: string; available: boolean }[];
  ramGB: number;
  models: LlmModel[];
  error?: string;
}

export type LlmStage = "check" | "write";

export interface TraceStage {
  stage: LlmStage;
  model: string;
  system: string;
  user: string;
  at: string;
  raw: string;
  stats?: { ms: number; promptTokens?: number; outputTokens?: number; tokensPerSec?: number };
  error?: string;
}

export interface LlmTrace {
  uid: number;
  model: string;
  relevant: boolean | null;
  reason: string;
  stages: TraceStage[];
}

export interface ImageInfo {
  id: string;
  /** eigenes: nachträglich im Dashboard hochgeladen */
  origin: "anhang" | "eingebettet" | "verlinkt" | "eigenes";
  filename: string;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  url?: string;
}

export interface MailImages {
  images: ImageInfo[];
  downloadLinks: { url: string; label: string }[];
  videos: VideoInfo[];
}

export interface MailSummary {
  uid: number;
  subject: string;
  sender: string;
  date: string;
  snippet: string;
  images: number;
  prefilter: boolean;
  hasDraft: boolean;
  /** Entwurf ohne Musikbezug */
  noMusic: boolean;
  /** Postfach, aus dem die Mail stammt */
  account: string;
  /** dieselbe Mail aus anderen Postfächern – zusammengefasst, wird mit erledigt */
  duplicates: { uid: number; account: string; sender: string; subject: string; date: string }[];
}

export interface MailboxStatus {
  name: string;
  folder: string;
  error?: string;
}

export interface Status {
  /** heute veröffentlicht – nur zur Anzeige */
  today: number;
  busy: boolean;
  nextSuggestion: string | null;
  pushSubscribers: number;
  config: {
    site: string;
    wpUrl: string;
    wpStatus: string;
    model: string;
    mailboxes: MailboxStatus[];
    seoPlugin: string;
    categories: string[];
    timezone: string;
    perRun: number;
    provider: "ollama" | "mlx" | "opencode" | "openai" | "claude";
    activeModel: string;
    suggestSchedule: string;
  };
}

export interface LogEntry {
  id: number;
  ts: string;
  kind: "published" | "suggested" | "skipped" | "error" | "run";
  subject: string;
  detail: string;
  link: string;
}

/** Testlauf: Entwürfe zur Ansicht – veröffentlicht wird nur, was der Benutzer freigibt */
export interface RunResult {
  skipped: number;
  previews: Article[];
  message: string;
}

export interface MailLink {
  url: string;
  label: string;
  /** dürfte nicht in den Artikel (Download, Presseordner, Hörprobe …) */
  blocked: boolean;
}

export interface OriginalMail {
  subject: string;
  sender: string;
  to: string;
  date: string;
  body: string;
  hasHtml: boolean;
  attachments: { filename: string; contentType: string; size: number }[];
  links: MailLink[];
}

export interface KonzertEvent {
  uid: string;
  source: string;
  date: string;
  time: string;
  artists: string[];
  title: string;
  venue: string;
  city: string;
  country: string;
  info: string;
  url: string;
  status: string;
}

export interface KalenderSource {
  id: string;
  name: string;
  found: number;
  sent: number;
  error?: string;
  skipped?: string;
  sendError?: string;
  duplicates?: number;
  wp?: { created: number; updated: number; locked: number; deleted: number; invalid: number };
}

export interface KalenderResult {
  at: string;
  dryRun: boolean;
  transferredAt?: string;
  transferredUids?: string[];
  transferredSources?: string[];
  sources: KalenderSource[];
  events: KonzertEvent[];
}

export type EventState = "neu" | "unverändert" | "geändert" | "dublette" | "gesperrt";

export interface WpRef {
  id: number;
  uid: string;
  source: string;
  title: string;
  post_status: string;
  edit_link: string;
}

export interface Abgleich {
  at: string;
  total: number;
  checks: { uid: string; state: EventState; existing?: WpRef; changes?: string[] }[];
  removals: (Pick<WpRef, "id" | "uid" | "source" | "title" | "edit_link"> & { date: string })[];
  wpDuplicates: [KonzertEvent & WpRef, KonzertEvent & WpRef][];
}

export interface KalenderQuelle {
  id: string;
  name: string;
  typ: "seite" | "vaddi" | "z7" | "regioactive" | "ticketmaster";
  url: string;
  /** nur bei Locations (seite, regioactive) */
  location?: string;
  ort?: string;
  land?: string;
}

/** Stil-Regelwerk: eigene Fassung oder die Vorlage aus stil/regelwerk.md */
export interface RegelwerkState {
  text: string;
  template: string;
  custom: boolean;
  updatedAt: string | null;
}

/** Einstellungen, wie sie das Dashboard sieht – ohne Passwörter und Keys */
export interface Setup {
  done: boolean;
  /** WordPress oder Postfach fehlt → Einrichtung öffnet sich von selbst */
  needed: boolean;
  site: { name: string; tone: string };
  wp: {
    url: string; user: string; hasAppPassword: boolean; categories: string;
    seoPlugin: "yoast" | "rankmath" | "none"; status: "publish" | "draft" | "pending"; featuredImage: boolean; ready: boolean;
  };
  mail: { maxAgeDays: number };
  limits: { perRun: number; timezone: string; suggestSchedule: string };
  llm: { ollamaUrl: string; mlxUrl: string; opencodeUrl: string; openaiUrl: string; claudeModel: string };
  kalender: { status: "publish" | "draft"; auto: boolean; schedule: string } | null;
  server: { host: string; port: number; hasPassword: boolean; fromEnv: { host: boolean; port: boolean } };
  keys: { anthropic: boolean; openai: boolean; ticketmaster: boolean };
  mailAccounts: number;
}
type Patch<T> = { [K in keyof T]?: T[K] extends object ? Patch<T[K]> : T[K] };
/** Geheimnisse: leer = behalten, null = löschen */
export interface SetupInput {
  site?: Patch<Setup["site"]>;
  wp?: Patch<Omit<Setup["wp"], "hasAppPassword" | "ready">> & { appPassword?: string | null };
  mail?: Patch<Setup["mail"]>;
  limits?: Patch<Setup["limits"]>;
  llm?: Patch<Setup["llm"]>;
  kalender?: Patch<NonNullable<Setup["kalender"]>>;
  server?: { host?: string; port?: number; password?: string | null };
  keys?: { anthropic?: string | null; openai?: string | null; ticketmaster?: string | null };
  done?: boolean;
}
export interface WpTest {
  ok: boolean;
  error?: string;
  name?: string;
  canPublish?: boolean;
  categories: { name: string; slug: string; count: number }[];
  seoPlugin?: Setup["wp"]["seoPlugin"];
  kalender?: boolean;
}

/** Postfach, wie es das Dashboard sieht – das Passwort bleibt auf dem Server */
export interface MailAccount {
  nr: number;
  name: string;
  user: string;
  host: string;
  port: number;
  folder: string;
  processedFolder: string;
  hasPassword: boolean;
  error?: string;
}
/** leeres Passwort beim Bearbeiten: altes behalten */
export type MailAccountInput = Omit<MailAccount, "nr" | "hasPassword" | "error"> & { password: string };
export interface ServerGuess { host: string; port: number; quelle: string }
export interface ConnectionTest { ok: boolean; error?: string; folders: string[]; messages?: number }

/** Location anlegen oder ändern – Typ ergibt sich aus der Adresse */
export interface LocationInput {
  name: string;
  url: string;
  location: string;
  ort: string;
  land: string;
}

/** Was die Prüfung einer Programm-Seite ergibt (ohne Sprachmodell) */
export interface Erkennung {
  typ: "seite" | "regioactive";
  urteil: "gut" | "unsicher" | "ungeeignet";
  hinweis: string;
  termine: number;
  vorschlag: { name?: string; ort?: string; land?: string };
  programmLinks: { text: string; url: string }[];
}

export interface KalenderState {
  busy: boolean;
  progress: { task: "abrufen" | "übertragen"; total: number; done: number; current: string; lines: string[]; startedAt: string; cancelling?: boolean; reading?: string } | null;
  nextRun: string | null;
  config: { schedule: string; auto: boolean; postStatus: string; ticketmaster: boolean; wpUrl: string };
  sources: KalenderQuelle[];
  /** Orte im Gebiet → Land */
  orte: Record<string, string>;
  last: KalenderResult | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => call<Status>("GET", "/status"),
  mails: () => call<{ mails: MailSummary[]; mailboxes: MailboxStatus[] }>("GET", "/mails"),
  log: () => call<LogEntry[]>("GET", "/log"),
  original: (uid: number) => call<OriginalMail>("GET", `/mails/${uid}`),
  originalHtmlUrl: (uid: number, images: boolean) => `/api/mails/${uid}/html${images ? "?images=1" : ""}`,
  originalHtml: async (uid: number, images: boolean) => {
    const res = await fetch(api.originalHtmlUrl(uid, images));
    if (!res.ok) throw new Error(`Mail-Ansicht: ${res.status}`);
    return res.text();
  },
  preview: (uid: number, refresh = false) => call<Article>("POST", `/mails/${uid}/preview${refresh ? "?refresh=1" : ""}`),
  saveDraft: (uid: number, article: Article) => call<Article>("PUT", `/mails/${uid}/draft`, article),
  publish: (uid: number) => call<{ id: number; link: string }>("POST", `/mails/${uid}/publish`),
  skip: (uid: number) => call<{ ok: true }>("POST", `/mails/${uid}/skip`),
  run: () => call<RunResult>("POST", "/run"),
  suggest: () => call<{ suggested: { uid: number; title: string } | null; message: string }>("POST", "/suggest"),
  images: (uid: number) => call<MailImages>("GET", `/mails/${uid}/images`),
  imageUrl: (uid: number, id: string) => `/api/mails/${uid}/images/${id}`,
  /** eigenes Bild hochladen – featured=false: Entwurf auf dem Server nicht anfassen (das macht der Editor) */
  uploadImage: async (uid: number, file: File, featured = false) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/mails/${uid}/images${featured ? "" : "?featured=0"}`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as { images: MailImages; image: ImageInfo; article: Article | null };
  },
  removeImage: (uid: number, id: string) => call<{ images: MailImages; article: Article | null }>("DELETE", `/mails/${uid}/images/${id}`),
  testPush: () => call<{ ok: true }>("POST", "/push/test"),
  models: (provider?: LlmProvider) => call<ModelsResponse>("GET", `/llm/models${provider ? `?provider=${provider}` : ""}`),
  setModel: (provider: LlmProvider, model: string) => call<{ provider: LlmProvider; current: string }>("PUT", "/llm/model", { provider, model }),
  wpCategories: () => call<WpCategories>("GET", "/wp/categories"),
  /** laufenden Entwurf abbrechen (z. B. wenn das Modell ins Leere läuft) */
  cancelLlm: () => call<{ cancelled: boolean }>("POST", "/llm/cancel"),
  trace: (uid: number) => call<LlmTrace | null>("GET", `/mails/${uid}/trace`),
  kalender: () => call<KalenderState>("GET", "/kalender"),
  kalenderRun: (dryRun: boolean, only: string[] = []) =>
    call<{ started: true }>("POST", `/kalender/run?dryRun=${dryRun ? 1 : 0}${only.length ? `&only=${only.join(",")}` : ""}`),
  kalenderCancel: () => call<{ cancelled: boolean }>("POST", "/kalender/cancel"),
  kalenderAbgleich: () => call<Abgleich>("GET", "/kalender/abgleich"),
  /** nichts angegeben: alle Termine (ersetzt die Quellen) · uids: nur diese ergänzen · sources: nur diese Quellen ersetzen */
  kalenderTransfer: (sel: { uids?: string[]; sources?: string[] } = {}) => call<{ started: true }>("POST", "/kalender/transfer", sel),
  addLocation: (l: LocationInput) => call<KalenderQuelle>("POST", "/kalender/quellen", l),
  updateLocation: (id: string, l: LocationInput) => call<KalenderQuelle>("PUT", `/kalender/quellen/${encodeURIComponent(id)}`, l),
  /** id: beim Bearbeiten die eigene Quelle, damit sie nicht als „schon eingetragen“ gilt */
  regelwerk: () => call<RegelwerkState>("GET", "/regelwerk"),
  saveRegelwerk: (text: string) => call<RegelwerkState>("PUT", "/regelwerk", { text }),
  resetRegelwerk: () => call<RegelwerkState>("DELETE", "/regelwerk"),
  setup: () => call<Setup>("GET", "/setup"),
  saveSetup: (s: SetupInput) => call<Setup>("PUT", "/setup", s),
  /** ohne Passwort: das gespeicherte */
  testWordPress: (wp: { url: string; user: string; appPassword?: string }) => call<WpTest>("POST", "/setup/wordpress/test", wp),
  mailAccounts: () => call<MailAccount[]>("GET", "/mail/accounts"),
  addMailAccount: (a: MailAccountInput) => call<MailAccount[]>("POST", "/mail/accounts", a),
  updateMailAccount: (nr: number, a: MailAccountInput) => call<MailAccount[]>("PUT", `/mail/accounts/${nr}`, a),
  deleteMailAccount: (nr: number) => call<MailAccount[]>("DELETE", `/mail/accounts/${nr}`),
  guessMailServer: (email: string) => call<ServerGuess | null>("POST", "/mail/accounts/erkennen", { email }),
  /** nr: beim Bearbeiten ohne neues Passwort das gespeicherte nehmen */
  testMailAccount: (a: MailAccountInput, nr?: number) => call<ConnectionTest>("POST", "/mail/accounts/test", { ...a, nr }),
  erkennen: (url: string, id?: string) => call<Erkennung>("POST", "/kalender/quellen/erkennen", { url, id }),
  setOrt: (name: string, land: string) => call<Record<string, string>>("PUT", "/kalender/orte", { name, land }),
  deleteOrt: (name: string) => call<Record<string, string>>("DELETE", `/kalender/orte/${encodeURIComponent(name)}`),
  deleteLocation: (id: string) => call<{ ok: true }>("DELETE", `/kalender/quellen/${encodeURIComponent(id)}`),
};

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "–";
