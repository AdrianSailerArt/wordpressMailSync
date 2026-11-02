/** SQLite (bun:sqlite): zwischengespeicherte Entwürfe und Verlauf fürs Dashboard. */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ArticleSchema, type Article } from "./rewrite.ts";

export type LogKind = "published" | "skipped" | "error" | "run";

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

  log(kind: LogKind, subject = "", detail = "", link = ""): void {
    this.db.query("INSERT INTO log (ts, kind, subject, detail, link) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), kind, subject, detail, link);
  }

  recentLog(limit = 100): LogEntry[] {
    return this.db.query<LogEntry, [number]>("SELECT * FROM log ORDER BY id DESC LIMIT ?").all(limit);
  }
}
