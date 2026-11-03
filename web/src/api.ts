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
    folder: string;
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

export interface OriginalMail {
  subject: string;
  sender: string;
  date: string;
  body: string;
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
  mails: () => call<MailSummary[]>("GET", "/mails"),
  log: () => call<LogEntry[]>("GET", "/log"),
  original: (uid: number) => call<OriginalMail>("GET", `/mails/${uid}`),
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
};

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "–";
