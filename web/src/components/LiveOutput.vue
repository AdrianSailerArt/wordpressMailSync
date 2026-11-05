<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { api } from "../api";
import { stageLabel, type LiveRun } from "../llm";
import Icon from "./Icon.vue";

/** Zeigt live, was das Sprachmodell gerade schreibt. */
const props = defineProps<{ run: LiveRun }>();

const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 250);
onUnmounted(() => clearInterval(timer));

const cancelling = ref(false);
async function cancel() {
  cancelling.value = true;
  // der Knopf bleibt gesperrt, bis der Lauf endet und die Anzeige verschwindet
  await api.cancelLlm().catch(() => (cancelling.value = false));
}

const seconds = (from: number) => Math.max(0, Math.round((now.value - from) / 1000));
const box = ref<HTMLElement | null>(null);
const follow = ref(true);

// automatisch mitscrollen, solange man nicht selbst nach oben gescrollt hat
watch(() => props.run.text.length, async () => {
  if (!follow.value) return;
  await nextTick();
  box.value?.scrollTo({ top: box.value.scrollHeight });
});

function onScroll() {
  const el = box.value;
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

const check = computed(() => {
  try {
    return props.run.checkRaw ? (JSON.parse(props.run.checkRaw) as { artist: string; music_news: boolean; reason: string }) : null;
  } catch {
    return null;
  }
});
</script>

<template>
  <div class="overflow-hidden rounded-xl bg-zinc-950 text-zinc-100 ring-1 ring-zinc-950/40 dark:ring-white/20">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 px-4 py-2.5 text-xs">
      <span class="relative flex size-2">
        <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span class="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      <span class="font-medium">{{ run.model }}</span>
      <span class="text-zinc-400">Stufe {{ run.stage === "check" ? 1 : 2 }}/2 · {{ stageLabel(run.stage) }}</span>
      <span class="ml-auto tabular-nums text-zinc-400">{{ run.text.length }} Zeichen · {{ seconds(run.stageStartedAt) }} s (gesamt {{ seconds(run.startedAt) }} s)</span>
      <button
        class="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-red-300 ring-1 ring-red-400/30 transition hover:bg-red-500/15 disabled:opacity-50"
        :disabled="cancelling"
        title="Generierung stoppen – die Mail bleibt unbearbeitet"
        @click="cancel"
      >
        <Icon name="stop" :size="12" />{{ cancelling ? "bricht ab …" : "Abbrechen" }}
      </button>
    </div>

    <p v-if="check && run.stage === 'write'" class="border-b border-white/10 px-4 py-2 text-xs text-zinc-400">
      Musik-Prüfung: <span class="font-medium text-zinc-100">{{ check.artist || "–" }}</span> · {{ check.reason }}
    </p>

    <pre
      ref="box"
      class="max-h-[50vh] min-h-32 overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-emerald-200/90"
      @scroll="onScroll"
    >{{ run.text }}<span class="ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-emerald-400" /></pre>
    <p v-if="!run.text" class="-mt-2 px-4 pb-3 text-xs text-zinc-400">
      Modell wird geladen und liest die Mail … (beim ersten Aufruf nach einem Modellwechsel kann das etwas dauern)
    </p>
  </div>
</template>
