/** Was das Sprachmodell gerade tut: Ereignisse für die Live-Ansicht und das KI-Protokoll je Entwurf. */

export type LlmStage = "check" | "write";

export interface LlmStats {
  ms: number;
  promptTokens?: number;
  outputTokens?: number;
  tokensPerSec?: number;
}

export type LlmEvent =
  | { type: "start"; uid: number; stage: LlmStage; model: string; system: string; user: string; at: string }
  | { type: "token"; uid: number; stage: LlmStage; text: string }
  | { type: "end"; uid: number; stage: LlmStage; raw: string; stats: LlmStats; error?: string }
  | { type: "result"; uid: number; relevant: boolean; reason: string; model: string };

export interface TraceStage {
  stage: LlmStage;
  model: string;
  system: string;
  user: string;
  at: string;
  raw: string;
  stats?: LlmStats;
  error?: string;
}

export interface LlmTrace {
  uid: number;
  model: string;
  relevant: boolean | null;
  reason: string;
  stages: TraceStage[];
}

type Listener = (e: LlmEvent) => void;

export class LlmEvents {
  private listeners = new Set<Listener>();
  /** laufende Durchläufe je Mail – für das Protokoll und für Clients, die mitten im Lauf dazukommen */
  private running = new Map<number, LlmTrace>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Durchläufe, die gerade aktiv sind (für neu verbundene Dashboards). */
  active(): LlmTrace[] {
    return [...this.running.values()];
  }

  emit(e: LlmEvent, onFinished?: (trace: LlmTrace) => void): void {
    let trace = this.running.get(e.uid);
    if (e.type === "start") {
      if (!trace || e.stage === "check") {
        trace = { uid: e.uid, model: e.model, relevant: null, reason: "", stages: [] };
        this.running.set(e.uid, trace);
      }
      trace.stages.push({ stage: e.stage, model: e.model, system: e.system, user: e.user, at: e.at, raw: "" });
    } else if (trace) {
      const current = trace.stages.at(-1);
      if (e.type === "token" && current) current.raw += e.text;
      if (e.type === "end" && current) Object.assign(current, { raw: e.raw, stats: e.stats, error: e.error });
      if (e.type === "result") {
        Object.assign(trace, { relevant: e.relevant, reason: e.reason, model: e.model });
        this.running.delete(e.uid);
        onFinished?.(trace);
      }
    }
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // ein abgebrochener Live-Client darf die Generierung nicht stören
      }
    }
  }
}
