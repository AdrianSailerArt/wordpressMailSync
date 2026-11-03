/** Live-Zustand des Sprachmodells – verbunden über Server-Sent Events mit /api/llm/events. */

import { reactive } from "vue";
import type { LlmStage, LlmTrace } from "./api";

export interface LiveRun {
  uid: number;
  model: string;
  stage: LlmStage;
  /** Text der aktuellen Stufe, so wie das Modell ihn gerade schreibt */
  text: string;
  /** Ergebnis der Musik-Prüfung, sobald Stufe 1 fertig ist */
  checkRaw: string;
  startedAt: number;
  stageStartedAt: number;
}

type ServerEvent =
  | { type: "snapshot"; active: LlmTrace[] }
  | { type: "start"; uid: number; stage: LlmStage; model: string; at: string }
  | { type: "token"; uid: number; stage: LlmStage; text: string }
  | { type: "end"; uid: number; stage: LlmStage; raw: string }
  | { type: "result"; uid: number };

export const live = reactive({
  connected: false,
  runs: {} as Record<number, LiveRun>,
  /** zählt hoch, wenn ein Durchlauf fertig ist – Komponenten laden dann Entwurf/Protokoll neu */
  finished: {} as Record<number, number>,
});

let source: EventSource | null = null;

export function connectLive(): void {
  if (source) return;
  source = new EventSource("/api/llm/events");
  source.onopen = () => (live.connected = true);
  source.onerror = () => (live.connected = false); // EventSource verbindet sich selbst neu
  source.onmessage = (msg) => handle(JSON.parse(msg.data) as ServerEvent);
}

function handle(e: ServerEvent) {
  const now = Date.now();
  if (e.type === "snapshot") {
    live.runs = {};
    for (const t of e.active) {
      const last = t.stages.at(-1);
      if (!last) continue;
      const started = Date.parse(t.stages[0]!.at);
      live.runs[t.uid] = {
        uid: t.uid, model: t.model, stage: last.stage, text: last.raw,
        checkRaw: t.stages.find((s) => s.stage === "check")?.raw ?? "",
        startedAt: started, stageStartedAt: Date.parse(last.at),
      };
    }
    return;
  }
  const run = live.runs[e.uid];
  switch (e.type) {
    case "start":
      if (!run || e.stage === "check") {
        live.runs[e.uid] = { uid: e.uid, model: e.model, stage: e.stage, text: "", checkRaw: "", startedAt: now, stageStartedAt: now };
      } else {
        Object.assign(run, { stage: e.stage, text: "", stageStartedAt: now });
      }
      break;
    case "token":
      if (run) run.text += e.text;
      break;
    case "end":
      if (run && e.stage === "check") run.checkRaw = e.raw;
      break;
    case "result":
      delete live.runs[e.uid];
      live.finished[e.uid] = (live.finished[e.uid] ?? 0) + 1;
      break;
  }
}

export const stageLabel = (stage: LlmStage) => (stage === "check" ? "Musik-Prüfung" : "Beitrag schreiben");
