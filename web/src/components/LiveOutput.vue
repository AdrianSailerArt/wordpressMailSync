<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { stageLabel, type LiveRun } from "../llm";

/** Zeigt live, was das Sprachmodell gerade schreibt. */
const props = defineProps<{ run: LiveRun }>();

const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 250);
onUnmounted(() => clearInterval(timer));

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
  <div class="rounded-lg border border-zinc-200 dark:border-zinc-800">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
      <span class="relative flex size-2">
        <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span class="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      <span class="font-medium">{{ run.model }}</span>
      <span class="text-zinc-500">Stufe {{ run.stage === "check" ? 1 : 2 }}/2 · {{ stageLabel(run.stage) }}</span>
      <span class="ml-auto tabular-nums text-zinc-500">{{ run.text.length }} Zeichen · {{ seconds(run.stageStartedAt) }} s (gesamt {{ seconds(run.startedAt) }} s)</span>
    </div>

    <p v-if="check && run.stage === 'write'" class="border-b border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800">
      Musik-Prüfung: <span class="font-medium text-zinc-800 dark:text-zinc-200">{{ check.artist || "–" }}</span> · {{ check.reason }}
    </p>

    <pre
      ref="box"
      class="max-h-[50vh] min-h-32 overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-zinc-700 dark:text-zinc-300"
      @scroll="onScroll"
    >{{ run.text }}<span class="ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-zinc-400" /></pre>
    <p v-if="!run.text" class="px-3 pb-3 -mt-2 text-xs text-zinc-400">
      Modell wird geladen und liest die Mail … (beim ersten Aufruf nach einem Modellwechsel kann das etwas dauern)
    </p>
  </div>
</template>
