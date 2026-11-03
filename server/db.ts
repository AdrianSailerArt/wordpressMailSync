/** SQLite (bun:sqlite): zwischengespeicherte Entwürfe und Verlauf fürs Dashboard. */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Fingerprint } from "./duplicates.ts";
import type { LlmTrace } from "./llm-events.ts";
import { ArticleSchema, type Article } from "./rewrite.ts";

export type LogKind = "published" | "suggested" | "skipped" | "error" | "run";

export interface LogEntry {
  id: number;
  ts: string;
  kind: LogKind;
  subject: string;
  detail: string;
  link: string;
}

export class Store {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS drafts (
      uid INTEGER PRIMARY KEY, article TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS processed (
      message_id TEXT PRIMARY KEY, status TEXT NOT NULL, ts TEXT NOT NULL)`);
    // Fingerabdrücke erledigter Mails – damit dieselbe Mail aus einem anderen Postfach später nicht nochmal kommt
    this.db.run(`CREATE TABLE IF NOT EXISTS fingerprints (
      message_id TEXT PRIMARY KEY, subject TEXT NOT NULL, subject_key TEXT NOT NULL, sketch TEXT NOT NULL, ts TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, created_at TEXT NOT NULL)`);
    this.db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS traces (uid INTEGER PRIMARY KEY, trace TEXT NOT NULL, updated_at TEXT NOT NULL)");
    this.db.run(`CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '')`);
  }

  getDraft(uid: number): Article | null {
    const row = this.db.query<{ article: string }, [number]>("SELECT article FROM drafts WHERE uid = ?").get(uid);
    return row ? ArticleSchema.parse(JSON.parse(row.article)) : null;
  }

  draftUids(): Set<number> {
    return new Set(this.db.query<{ uid: number }, []>("SELECT uid FROM drafts").all().map((r) => r.uid));
  }

  saveDraft(uid: number, article: Article): void {
    this.db.query("INSERT OR REPLACE INTO drafts (uid, article, updated_at) VALUES (?, ?, ?)")
      .run(uid, JSON.stringify(article), new Date().toISOString());
  }

  deleteDraft(uid: number): void {
    this.db.query("DELETE FROM drafts WHERE uid = ?").run(uid);
  }

  /** Erledigte Mails (veröffentlicht oder übersprungen) – unabhängig von IMAP-Markierungen. */
  markProcessed(messageId: string, status: "done" | "skipped"): void {
    this.db.query("INSERT OR REPLACE INTO processed (message_id, status, ts) VALUES (?, ?, ?)")
      .run(messageId, status, new Date().toISOString());
  }

  processedIds(): Set<string> {
    return new Set(this.db.query<{ message_id: string }, []>("SELECT message_id FROM processed").all().map((r) => r.message_id));
  }

  saveFingerprint(print: Fingerprint, subject: string): void {
    this.db.query("INSERT OR REPLACE INTO fingerprints (message_id, subject, subject_key, sketch, ts) VALUES (?, ?, ?, ?, ?)")
      .run(print.messageId, subject, print.subjectKey, JSON.stringify(print.sketch), new Date().toISOString());
  }

  /** Fingerabdrücke der letzten Tage (ältere Mails kommen ohnehin nicht mehr als Kandidaten). */
  fingerprints(days: number): (Fingerprint & { subject: string })[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db
      .query<{ message_id: string; subject: string; subject_key: string; sketch: string }, [string]>(
        "SELECT message_id, subject, subject_key, sketch FROM fingerprints WHERE ts >= ?",
      )
      .all(since)
      .map((r) => ({ messageId: r.message_id, subject: r.subject, subjectKey: r.subject_key, sketch: JSON.parse(r.sketch) as number[] }));
  }

  addSubscription(sub: { endpoint: string }): void {
    this.db.query("INSERT OR REPLACE INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?)")
      .run(sub.endpoint, JSON.stringify(sub), new Date().toISOString());
  }

  removeSubscription(endpoint: string): void {
    this.db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  subscriptions<T>(): T[] {
    return this.db.query<{ subscription: string }, []>("SELECT subscription FROM push_subscriptions").all()
      .map((r) => JSON.parse(r.subscription) as T);
  }

  getSetting(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  /** KI-Protokoll des letzten Durchlaufs einer Mail */
  saveTrace(trace: LlmTrace): void {
    this.db.query("INSERT OR REPLACE INTO traces (uid, trace, updated_at) VALUES (?, ?, ?)")
      .run(trace.uid, JSON.stringify(trace), new Date().toISOString());
  }

  getTrace(uid: number): LlmTrace | null {
    const row = this.db.query<{ trace: string }, [number]>("SELECT trace FROM traces WHERE uid = ?").get(uid);
    return row ? (JSON.parse(row.trace) as LlmTrace) : null;
  }

  log(kind: LogKind, subject = "", detail = "", link = ""): void {
    this.db.query("INSERT INTO log (ts, kind, subject, detail, link) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), kind, subject, detail, link);
  }

  recentLog(limit = 100): LogEntry[] {
    return this.db.query<LogEntry, [number]>("SELECT * FROM log ORDER BY id DESC LIMIT ?").all(limit);
  }
}
