/** Typisierter Zugriff auf die REST-API des Servers. */

export interface Article {
  relevant: boolean;
  reason: string;
  title: string;
  slug: string;
  focus_keyword: string;
  meta_description: string;
  excerpt: string;
  content_html: string;
  category: string;
  tags: string[];
  image_credit: string;
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
  };
}

export interface LogEntry {
  id: number;
  ts: string;
  kind: "published" | "skipped" | "error" | "run";
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
  preview: (uid: number, refresh = false) => call<Article>("POST", `/mails/${uid}/preview${refresh ? "?refresh=1" : ""}`),
  saveDraft: (uid: number, article: Article) => call<Article>("PUT", `/mails/${uid}/draft`, article),
  publish: (uid: number) => call<{ id: number; link: string }>("POST", `/mails/${uid}/publish`),
  skip: (uid: number) => call<{ ok: true }>("POST", `/mails/${uid}/skip`),
  run: (dryRun: boolean) => call<RunResult>("POST", `/run${dryRun ? "?dryRun=1" : ""}`),
};

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "–";
