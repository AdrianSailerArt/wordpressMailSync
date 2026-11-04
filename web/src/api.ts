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
  tags: string[];
  image_credit: string;
  /** "" = automatisch (größtes Bild), "none" = kein Beitragsbild, sonst Bild-ID */
  featured_image: string;
  inline_images: string[];
  generated_by: string;
  /** fehlt = automatisch das erste Video, [] = keins, sonst gewählte YouTube-IDs */
  videos?: string[];
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

export interface ModelsResponse {
  provider: "ollama" | "claude";
  current: string;
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
  origin: "anhang" | "eingebettet" | "verlinkt";
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
  today: number;
  limit: number;
  busy: boolean;
  schedule: string;
  nextRun: string | null;
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
    autoPublish: boolean;
    provider: "ollama" | "claude";
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

export interface RunResult {
  published: { title: string; link: string }[];
  skipped: number;
  dryRun: boolean;
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

export interface KalenderState {
  busy: boolean;
  progress: { task: "abrufen" | "übertragen"; total: number; done: number; current: string; lines: string[]; startedAt: string; cancelling?: boolean; reading?: string } | null;
  nextRun: string | null;
  config: { schedule: string; auto: boolean; postStatus: string; ticketmaster: boolean; wpUrl: string };
  sources: { id: string; name: string; typ: "seite" | "vaddi" | "z7" | "regioactive" | "ticketmaster"; url: string }[];
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
  run: (dryRun: boolean) => call<RunResult>("POST", `/run${dryRun ? "?dryRun=1" : ""}`),
  suggest: () => call<{ suggested: { uid: number; title: string } | null; message: string }>("POST", "/suggest"),
  images: (uid: number) => call<MailImages>("GET", `/mails/${uid}/images`),
  imageUrl: (uid: number, id: string) => `/api/mails/${uid}/images/${id}`,
  testPush: () => call<{ ok: true }>("POST", "/push/test"),
  models: () => call<ModelsResponse>("GET", "/llm/models"),
  setModel: (model: string) => call<{ current: string }>("PUT", "/llm/model", { model }),
  trace: (uid: number) => call<LlmTrace | null>("GET", `/mails/${uid}/trace`),
  kalender: () => call<KalenderState>("GET", "/kalender"),
  kalenderRun: (dryRun: boolean, only: string[] = []) =>
    call<{ started: true }>("POST", `/kalender/run?dryRun=${dryRun ? 1 : 0}${only.length ? `&only=${only.join(",")}` : ""}`),
  kalenderCancel: () => call<{ cancelled: boolean }>("POST", "/kalender/cancel"),
  kalenderAbgleich: () => call<Abgleich>("GET", "/kalender/abgleich"),
  /** nichts angegeben: alle Termine (ersetzt die Quellen) · uids: nur diese ergänzen · sources: nur diese Quellen ersetzen */
  kalenderTransfer: (sel: { uids?: string[]; sources?: string[] } = {}) => call<{ started: true }>("POST", "/kalender/transfer", sel),
};

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "–";
