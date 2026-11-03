/**
 * Abgleich mit dem, was schon in WordPress steht – bevor etwas übertragen wird. Erkennt Dubletten
 * gegenüber Terminen anderer Quellen oder von Hand angelegten, Änderungen und was beim Übertragen wegfiele.
 */

import { isSameEvent, type KonzertEvent } from "./events.ts";

/** Ein Termin aus WordPress (GET /konzertkalender/v1/bestand) */
export interface WpEvent extends KonzertEvent {
  id: number;
  locked: boolean;
  post_status: string;
  edit_link: string;
}

export type EventState = "neu" | "unverändert" | "geändert" | "dublette" | "gesperrt";

export interface EventCheck {
  uid: string;
  state: EventState;
  /** der passende Termin in WordPress (gleiche uid, gleicher Abend derselben Quelle oder Dublette) */
  existing?: Pick<WpEvent, "id" | "uid" | "source" | "title" | "post_status" | "edit_link">;
  /** welche Felder sich ändern würden */
  changes?: string[];
}

export interface Abgleich {
  at: string;
  /** Anzahl Termine in WordPress */
  total: number;
  checks: EventCheck[];
  /** fiele beim Übertragen aller Termine weg (Quelle liefert ihn nicht mehr) */
  removals: Pick<WpEvent, "id" | "uid" | "source" | "date" | "title" | "edit_link">[];
  /** Termine, die in WordPress schon doppelt stehen */
  wpDuplicates: [WpEvent, WpEvent][];
}

const FIELDS = ["date", "time", "title", "venue", "city", "country", "info", "url", "status", "artists"] as const;

function changedFields(a: KonzertEvent, b: KonzertEvent): string[] {
  return FIELDS.filter((f) => (f === "artists" ? a.artists.join("\n") !== b.artists.join("\n") : a[f] !== b[f]));
}

const ref = (w: WpEvent) => ({ id: w.id, uid: w.uid, source: w.source, title: w.title, post_status: w.post_status, edit_link: w.edit_link });

/**
 * `events`: was übertragen werden soll (bereits untereinander zusammengeführt), `existing`: Bestand in WordPress,
 * `sources`: Quellen, die beim Übertragen ersetzt werden, `today`: ab hier wird gelöscht.
 */
export function compare(events: KonzertEvent[], existing: WpEvent[], sources: string[], today: string): Abgleich {
  const byUid = new Map(existing.map((w) => [w.uid, w]));
  const replaced = new Set(sources);
  const claimed = new Set<number>();
  const checks: EventCheck[] = [];

  for (const e of events) {
    // 1. gleiche uid → derselbe Eintrag
    let match = byUid.get(e.uid);
    // 2. gleicher Abend derselben Quelle, aber andere uid (z. B. Künstlername leicht anders geschrieben) → aktualisieren statt neu
    match ??= existing.find((w) => w.source === e.source && !claimed.has(w.id) && isSameEvent(w, e));
    if (match && match.source === e.source) {
      claimed.add(match.id);
      const changes = changedFields(match, e);
      checks.push({ uid: e.uid, state: match.locked ? "gesperrt" : changes.length ? "geändert" : "unverändert", existing: ref(match), changes });
      continue;
    }
    // 3. derselbe Abend steht schon aus einer anderen Quelle oder von Hand drin – nicht nochmal anlegen.
    //    Termine von Quellen, die gerade ersetzt werden, zählen nur, wenn sie gesperrt sind (sonst fallen sie gleich weg).
    const twin = existing.find((w) => w.source !== e.source && (w.locked || !replaced.has(w.source)) && isSameEvent(w, e));
    if (twin) {
      checks.push({ uid: e.uid, state: "dublette", existing: ref(twin) });
      continue;
    }
    checks.push({ uid: e.uid, state: "neu" });
  }

  const sent = new Set(events.map((e) => e.uid));
  const removals = existing
    .filter((w) => replaced.has(w.source) && !w.locked && w.date >= today && !sent.has(w.uid) && !claimed.has(w.id))
    .map((w) => ({ id: w.id, uid: w.uid, source: w.source, date: w.date, title: w.title, edit_link: w.edit_link }));

  const wpDuplicates: [WpEvent, WpEvent][] = [];
  existing.forEach((a, i) => {
    for (const b of existing.slice(i + 1)) if (isSameEvent(a, b)) wpDuplicates.push([a, b]);
  });

  return { at: new Date().toISOString(), total: existing.length, checks, removals, wpDuplicates };
}

/**
 * Was tatsächlich an WordPress geht: Dubletten fallen weg, Termine mit abweichender uid bekommen die uid
 * des vorhandenen Eintrags (damit er aktualisiert statt doppelt angelegt wird).
 */
export function prepare(events: KonzertEvent[], abgleich: Abgleich): KonzertEvent[] {
  const checks = new Map(abgleich.checks.map((c) => [c.uid, c]));
  return events.flatMap((e) => {
    const c = checks.get(e.uid);
    if (c?.state === "dublette") return [];
    return [c?.existing && c.existing.uid !== e.uid ? { ...e, uid: c.existing.uid } : e];
  });
}
