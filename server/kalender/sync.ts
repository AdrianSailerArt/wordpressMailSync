/** Konzertkalender: alle Quellen abrufen, Dubletten zusammenführen und ans WordPress-Plugin schicken. */

import { createHash } from "node:crypto";
import type { KalenderConfig } from "../config.ts";
import { generateJson } from "../rewrite.ts";
import { localDate } from "../wordpress.ts";
import { fetchText, loadQuellen, mergeDuplicates, type KonzertEvent, type Quelle, type Quellen } from "./events.ts";
import { compare, prepare, type Abgleich, type WpEvent } from "./abgleich.ts";
import { fetchSeite, type AskJson } from "./seite.ts";
import { fetchTicketmaster } from "./ticketmaster.ts";
import { fetchVaddi } from "./vaddi.ts";
import { fetchRegioactive } from "./regioactive.ts";
import { fetchZ7 } from "./z7.ts";

export interface SourceResult {
  id: string;
  name: string;
  /** Termine nach Filter, vor dem Zusammenführen */
  found: number;
  /** davon übertragen (ohne Dubletten anderer Quellen) */
  sent: number;
  error?: string;
  skipped?: string;
  /** Fehler beim Übertragen (der Abruf selbst hat geklappt) */
  sendError?: string;
  /** beim Übertragen ausgelassen, weil schon in WordPress */
  duplicates?: number;
  wp?: { created: number; updated: number; locked: number; deleted: number; invalid: number };
}

export interface KalenderResult {
  at: string;
  dryRun: boolean;
  /** wann das Ergebnis an WordPress ging (fehlt beim Probelauf) */
  transferredAt?: string;
  /** einzeln übertragene Termine eines Probelaufs */
  transferredUids?: string[];
  /** einzeln übertragene Quellen eines Probelaufs */
  transferredSources?: string[];
  /** Abruf wurde abgebrochen – enthält nur die fertigen Quellen */
  cancelled?: boolean;
  sources: SourceResult[];
  events: KonzertEvent[];
}

export interface KalenderProgress {
  task: "abrufen" | "übertragen";
  total: number;
  done: number;
  /** Quelle, die gerade gelesen oder übertragen wird */
  current: string;
  lines: string[];
  startedAt: string;
  /** Abbrechen wurde angefordert, die laufende Anfrage wird gerade gestoppt */
  cancelling?: boolean;
  /** Seite, die das Sprachmodell gerade liest */
  reading?: string;
}

/** Was übertragen wird: nichts angegeben = alles, `uids` = nur diese Termine, `sources` = nur diese Quellen */
export interface Auswahl {
  uids?: string[];
  sources?: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Zwischenspeicher für Antworten des Sprachmodells (im Dashboard die SQLite-Datenbank) */
export interface KalenderCache {
  getCached(key: string): string | null;
  setCached(key: string, value: string): void;
  touchCached(key: string): void;
}

/** wie viele Seitenabschnitte das Modell lesen musste und wie viele aus dem Zwischenspeicher kamen */
interface AskStats {
  asked: number;
  cached: number;
}

export class Kalender {
  busy = false;

  constructor(private cfg: KalenderConfig, private model: () => string, private cache?: KalenderCache) {}

  /**
   * Modell fragen – oder die gespeicherte Antwort für genau diesen Abschnitt nehmen. Der Schlüssel enthält Modell,
   * Anweisung (mit Monat statt Tag, wegen der Jahreszahl) und Abschnitt. Leere Antworten werden nicht gespeichert,
   * damit beim nächsten Mal neu gefragt wird.
   */
  private askCached(model: string, today: string, abort: AbortSignal, stats: AskStats): AskJson {
    // Anbieter zusammen mit dem Modell festhalten – er lässt sich im Dashboard umschalten
    const llm = { ...this.cfg.llm };
    return async (system, user, schema) => {
      const key = createHash("sha256").update(`${model}\n${system.replaceAll(today, today.slice(0, 7))}\n${user}`).digest("hex");
      const hit = this.cache?.getCached(key);
      if (hit) {
        this.cache!.touchCached(key);
        stats.cached++;
        return JSON.parse(hit);
      }
      const raw = await generateJson(llm, model, system, user, schema, abort);
      stats.asked++;
      if ((raw as { events?: unknown[] }).events?.length) this.cache?.setCached(key, JSON.stringify(raw));
      return raw;
    };
  }

  private async fetchSource(q: Quelle, quellen: Quellen, today: string, abort: AbortSignal, stats: AskStats): Promise<KonzertEvent[]> {
    switch (q.typ) {
      case "vaddi":
        return fetchVaddi(q.url, today, quellen, abort);
      case "z7":
        return fetchZ7(q.url, today, quellen, abort);
      case "regioactive":
        return fetchRegioactive(q, today, quellen, abort);
      case "ticketmaster":
        if (!this.cfg.ticketmasterKey) throw new Error("TICKETMASTER_API_KEY fehlt");
        return (await fetchTicketmaster(this.cfg.ticketmasterKey, quellen.gebiet, quellen.ausschliessen, abort)).filter((e) => e.date >= today);
      case "seite": {
        const model = this.model();
        return fetchSeite(q, await fetchText(q.url, abort), today, quellen.ausschliessen, this.askCached(model, today, abort, stats));
      }
    }
  }

  private async wp(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const auth = "Basic " + Buffer.from(`${this.cfg.wp.user}:${this.cfg.wp.appPassword.replace(/\s+/g, "")}`).toString("base64");
    const res = await fetch(`${this.cfg.wp.url}/wp-json/konzertkalender/v1/${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", "User-Agent": "buehnenpost/0.3" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 404) {
      throw new Error(path === "bestand"
        ? "WordPress kennt /konzertkalender/v1/bestand nicht – bitte das Plugin ab Version 0.2.0 hochladen"
        : `WordPress kennt /konzertkalender/v1/${path} nicht – ist das Plugin aktiviert?`);
    }
    if (!res.ok) throw new Error(`WordPress: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  private post(source: string, events: KonzertEvent[], replace: boolean) {
    return this.wp("POST", "sync", { source, replace, post_status: this.cfg.postStatus, events }) as Promise<SourceResult["wp"]>;
  }

  /** Alle kommenden Termine in WordPress, auch Entwürfe */
  existing(): Promise<WpEvent[]> {
    return this.wp("GET", "bestand") as Promise<WpEvent[]>;
  }

  /** Quellen, die beim Übertragen aller Termine ersetzt würden (ohne Fehler und mit Treffern) */
  private replaceable = (result: KalenderResult) => result.sources.filter((s) => !s.error && !s.skipped).map((s) => s.id);

  /**
   * Vergleich mit WordPress für das, was übertragen werden soll: alle Termine, nur ausgewählte (`uids`, ersetzt nichts)
   * oder nur bestimmte Quellen (`sources`, ersetzt nur diese).
   */
  async abgleich(result: KalenderResult, sel: Auswahl = {}, existing?: WpEvent[]): Promise<Abgleich> {
    const { events, replaced } = this.pick(result, sel);
    return compare(events, existing ?? await this.existing(), replaced, localDate(this.cfg.timezone));
  }

  private pick(result: KalenderResult, { uids, sources }: Auswahl) {
    if (uids?.length) return { events: result.events.filter((e) => uids.includes(e.uid)), replaced: [] as string[] };
    const replaced = this.replaceable(result).filter((id) => !sources?.length || sources.includes(id));
    return { events: result.events.filter((e) => replaced.includes(e.source)), replaced };
  }

  /** Was gerade passiert – fürs Dashboard */
  progress: KalenderProgress | null = null;

  /** Quellen aus der Liste, für die Anzeige */
  sources(): { id: string; name: string; typ: Quelle["typ"]; url: string }[] {
    return loadQuellen(this.cfg.file).quellen.map((q) => ({ id: q.id, name: q.name, typ: q.typ, url: "url" in q ? q.url : "https://developer.ticketmaster.com" }));
  }

  private begin(task: KalenderProgress["task"], total: number, log?: (line: string) => void) {
    if (this.busy) throw new Error("Der Kalender wird gerade schon abgerufen");
    this.busy = true;
    const progress: KalenderProgress = { task, total, done: 0, current: "", lines: [], startedAt: new Date().toISOString() };
    this.progress = progress;
    this.abort = new AbortController();
    return (line: string) => {
      progress.lines.push(line);
      log?.(line);
    };
  }

  private end() {
    this.busy = false;
    this.progress = null;
    this.abort = null;
  }

  private abort: AbortController | null = null;

  /** Laufenden Abruf abbrechen: auch eine laufende Modell-Anfrage wird gestoppt, übertragen wird nichts mehr. */
  cancel(): boolean {
    if (!this.abort || this.abort.signal.aborted) return false;
    this.abort.abort(new Error("Abgebrochen"));
    if (this.progress) this.progress.cancelling = true;
    return true;
  }

  /** Alle (oder `only`) Quellen abrufen und Dubletten zusammenführen – überträgt nichts. */
  private async collect(only: string[] | undefined, log: (line: string) => void): Promise<KalenderResult> {
    const quellen = loadQuellen(this.cfg.file);
    const today = localDate(this.cfg.timezone);
    const selected = quellen.quellen.filter((q) => !only?.length || only.includes(q.id));
    if (this.progress) this.progress.total = selected.length;
    const byId = new Map<string, { result: SourceResult; events: KonzertEvent[] }>();
    const running = new Set<string>();
    const abort = this.abort!.signal;
    const show = () => {
      if (this.progress) this.progress.current = [...running].join(", ");
    };

    const fetchOne = async (q: Quelle) => {
      if (abort.aborted) return;
      running.add(q.name);
      show();
      if (q.typ === "seite" && this.progress) this.progress.reading = q.name;
      const stats: AskStats = { asked: 0, cached: 0 };
      try {
        const events = (await this.fetchSource(q, quellen, today, abort, stats)).map((e) => ({ ...e, source: q.id }));
        byId.set(q.id, { result: { id: q.id, name: q.name, found: events.length, sent: 0 }, events });
        const cached = stats.cached ? ` (${stats.cached} von ${stats.cached + stats.asked} Abschnitten aus dem Zwischenspeicher)` : "";
        log(`${q.name}: ${events.length} Termine${cached}`);
      } catch (err) {
        // abgebrochene Quelle zählt nicht – sie behält ihr voriges Ergebnis
        if (abort.aborted) return;
        byId.set(q.id, { result: { id: q.id, name: q.name, found: 0, sent: 0, error: message(err) }, events: [] });
        log(`${q.name}: Fehler – ${message(err)}`);
      } finally {
        running.delete(q.name);
        if (this.progress?.reading === q.name) this.progress.reading = "";
        if (this.progress && !abort.aborted) this.progress.done++;
        show();
      }
    };

    // Das Sprachmodell schafft nur eine Seite gleichzeitig – Vaddi, Z7 und Ticketmaster laufen derweil nebenher
    const llm = selected.filter((q) => q.typ === "seite");
    await Promise.all([
      (async () => {
        for (const q of llm) await fetchOne(q);
      })(),
      ...selected.filter((q) => q.typ !== "seite").map(fetchOne),
    ]);

    // in der Reihenfolge der Quellenliste – sie entscheidet beim Zusammenführen
    const done = selected.flatMap((q) => byId.get(q.id) ?? []);
    const results = done.map((d) => d.result);
    const all = done.flatMap((d) => d.events);
    if (abort.aborted) log(`Abgebrochen – ${results.length} von ${selected.length} Quellen fertig, nichts übertragen`);

    // Reihenfolge der Quellenliste = Vorrang beim Zusammenführen
    const merged = mergeDuplicates(all);
    for (const result of results) {
      result.sent = merged.filter((e) => e.source === result.id).length;
      // Ohne Treffer nichts ersetzen: sonst löscht eine geänderte oder kaputte Seite alle Termine der Quelle
      if (!result.error && !result.found) result.skipped = "keine Termine gefunden – vorhandene bleiben stehen";
    }
    return { at: new Date().toISOString(), dryRun: true, sources: results, events: merged, ...(abort.aborted && { cancelled: true }) };
  }

  /**
   * An WordPress schicken – vorher mit dem Bestand abgleichen: Dubletten fallen weg, leicht abweichende
   * Termine derselben Quelle aktualisieren den vorhandenen Eintrag. Ohne `uids` werden alle Quellen ersetzt
   * (Quellen mit Fehler oder ohne Treffer bleiben unangetastet), mit `uids` nur diese Termine ergänzt.
   */
  private async send(result: KalenderResult, log: (line: string) => void, sel: Auswahl = {}): Promise<KalenderResult> {
    const { uids, sources: only } = sel;
    const selected = !!uids?.length;
    const picked = this.pick(result, sel);
    const abgleich = await this.abgleich(result, sel);
    const events = prepare(picked.events, abgleich);
    const duplicates = abgleich.checks.filter((c) => c.state === "dublette");
    if (duplicates.length) log(`${duplicates.length} Termine stehen schon in WordPress und werden nicht nochmal angelegt`);

    const sources: SourceResult[] = result.sources.map((s) => ({ ...s, sendError: undefined }));
    const targets = selected
      ? sources.filter((s) => events.some((e) => e.source === s.id))
      : sources.filter((s) => picked.replaced.includes(s.id));
    if (this.progress) Object.assign(this.progress, { total: targets.length, done: 0 });
    for (const s of targets) {
      if (this.abort?.signal.aborted) {
        log(`Abgebrochen – ${s.name} und folgende nicht übertragen`);
        break;
      }
      if (this.progress) this.progress.current = s.name;
      try {
        s.wp = await this.post(s.id, events.filter((e) => e.source === s.id), !selected);
        s.duplicates = duplicates.filter((c) => result.events.find((e) => e.uid === c.uid)?.source === s.id).length;
        log(`${s.name}: ${s.wp?.created} neu, ${s.wp?.updated} aktualisiert, ${s.wp?.deleted} entfernt${s.duplicates ? `, ${s.duplicates} Dubletten ausgelassen` : ""}`);
      } catch (err) {
        s.sendError = message(err);
        log(`${s.name}: Fehler beim Übertragen – ${s.sendError}`);
      }
      if (this.progress) this.progress.done++;
    }
    const now = new Date().toISOString();
    if (selected) {
      // Auswahl: der Rest ist weiter nicht übertragen
      return { ...result, sources, transferredUids: [...new Set([...(result.transferredUids ?? []), ...uids!])] };
    }
    if (only?.length && targets.length < this.replaceable(result).length) {
      // einzelne Quellen: die übrigen sind weiter nicht übertragen
      return { ...result, sources, transferredSources: [...new Set([...(result.transferredSources ?? []), ...targets.map((s) => s.id)])] };
    }
    return { ...result, dryRun: false, transferredAt: now, transferredUids: undefined, transferredSources: undefined, sources };
  }

  /** `only`: nur diese Quellen-IDs abrufen; `dryRun`: nichts übertragen. */
  async run(opts: { dryRun?: boolean; only?: string[]; log?: (line: string) => void } = {}): Promise<KalenderResult> {
    const log = this.begin("abrufen", 0, opts.log);
    try {
      const result = await this.collect(opts.only, log);
      if (opts.dryRun || result.cancelled) return result;
      if (this.progress) this.progress.task = "übertragen";
      return await this.send(result, log);
    } finally {
      this.end();
    }
  }

  /**
   * Teilergebnis (einzelne Quellen getestet) mit dem vorigen Ergebnis zusammenlegen, damit die übrigen
   * Quellen nicht verschwinden. Dubletten werden in der Reihenfolge der Quellenliste neu aufgelöst.
   */
  combine(prev: KalenderResult | null, partial: KalenderResult): KalenderResult {
    if (!prev) return partial;
    const tested = new Set(partial.sources.map((s) => s.id));
    const order = this.sources().map((s) => s.id);
    // Quellen, die inzwischen aus der Liste entfernt wurden, fallen weg
    const known = (id: string) => order.includes(id);
    prev = { ...prev, sources: prev.sources.filter((s) => known(s.id)), events: prev.events.filter((e) => known(e.source)) };
    const rank = (id: string) => (order.indexOf(id) + 1 || order.length + 1);
    const events = mergeDuplicates([...prev.events.filter((e) => !tested.has(e.source)), ...partial.events]
      .sort((a, b) => rank(a.source) - rank(b.source)));
    const sources = [...prev.sources.filter((s) => !tested.has(s.id)), ...partial.sources]
      .sort((a, b) => rank(a.id) - rank(b.id))
      .map((s) => ({ ...s, sent: events.filter((e) => e.source === s.id).length }));
    return { at: partial.at, dryRun: prev.dryRun || partial.dryRun, sources, events };
  }

  /** Ergebnis eines Probelaufs übertragen (alle oder nur `uids`), ohne die Seiten noch einmal zu lesen. */
  async transfer(result: KalenderResult, log?: (line: string) => void, sel: Auswahl = {}): Promise<KalenderResult> {
    const write = this.begin("übertragen", 0, log);
    try {
      return await this.send(result, write, sel);
    } finally {
      this.end();
    }
  }
}
