<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { api, formatDate, type LlmTrace, type TraceStage } from "../api";
import { live, stageLabel } from "../llm";

/** KI-Protokoll: was das Modell bei diesem Entwurf bekommen und geantwortet hat. */
const props = defineProps<{ uid: number }>();

const trace = ref<LlmTrace | null>(null);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    trace.value = await api.trace(props.uid);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => live.finished[props.uid], load);

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const seconds = (s: TraceStage) => (s.stats ? `${(s.stats.ms / 1000).toFixed(1)} s` : "–");
</script>

<template>
  <p v-if="loading" class="text-sm text-zinc-500">Protokoll wird geladen …</p>
  <p v-else-if="!trace" class="text-sm text-zinc-500">
    Für diesen Entwurf gibt es noch kein Protokoll (er wurde vor dieser Funktion erstellt). „Neu generieren“ erzeugt eins.
  </p>
  <div v-else class="space-y-4 text-sm">
    <p class="text-xs text-zinc-500">
      Modell <span class="font-medium text-zinc-800 dark:text-zinc-200">{{ trace.model }}</span> ·
      {{ trace.relevant ? "als Musik-News erkannt" : trace.reason }}
    </p>

    <section v-for="(s, i) in trace.stages" :key="i" class="rounded-xl ring-1 ring-zinc-950/5 dark:ring-white/10">
      <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-zinc-950/5 px-3 py-2 text-xs dark:border-white/10">
        <span class="font-medium">{{ s.stage === "check" ? "1" : "2" }} · {{ stageLabel(s.stage) }}</span>
        <span class="text-zinc-500">{{ formatDate(s.at) }}</span>
        <span class="ml-auto flex gap-3 tabular-nums text-zinc-500">
          <span title="Dauer">{{ seconds(s) }}</span>
          <span v-if="s.stats?.promptTokens" title="Eingabe-Tokens">{{ s.stats.promptTokens }} rein</span>
          <span v-if="s.stats?.outputTokens" title="Ausgabe-Tokens">{{ s.stats.outputTokens }} raus</span>
          <span v-if="s.stats?.tokensPerSec" title="Geschwindigkeit">{{ s.stats.tokensPerSec }} Tok/s</span>
        </span>
      </header>
      <p v-if="s.error" class="border-b border-zinc-950/5 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-white/10 dark:bg-rose-500/10 dark:text-rose-300">
        {{ s.error }}
      </p>
      <div class="divide-y divide-zinc-950/5 dark:divide-white/5">
        <details class="group px-3 py-2">
          <summary class="cursor-pointer text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Anweisung an das Modell ({{ s.system.length }} Zeichen)</summary>
          <pre class="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-zinc-600 dark:text-zinc-400">{{ s.system }}</pre>
        </details>
        <details class="px-3 py-2">
          <summary class="cursor-pointer text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Eingabe – die Mail ({{ s.user.length }} Zeichen)</summary>
          <pre class="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-zinc-600 dark:text-zinc-400">{{ s.user }}</pre>
        </details>
        <details class="px-3 py-2" open>
          <summary class="cursor-pointer text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Antwort des Modells (roh)</summary>
          <pre class="mt-2 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-zinc-700 dark:text-zinc-300">{{ pretty(s.raw) }}</pre>
        </details>
      </div>
    </section>
  </div>
</template>
