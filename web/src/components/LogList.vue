<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, formatDate, type LogEntry } from "../api";
import type { IconName } from "../icons";
import Icon from "./Icon.vue";

const entries = ref<LogEntry[]>([]);
const error = ref("");

const labels: Record<LogEntry["kind"], [string, string, IconName]> = {
  published: ["Veröffentlicht", "bg-emerald-50 text-emerald-600 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300", "send"],
  suggested: ["Vorschlag", "bg-sky-50 text-sky-600 ring-sky-600/15 dark:bg-sky-500/10 dark:text-sky-300", "sparkles"],
  skipped: ["Übersprungen", "bg-zinc-100 text-zinc-500 ring-zinc-950/5 dark:bg-white/5 dark:text-zinc-400", "skip"],
  error: ["Fehler", "bg-rose-50 text-rose-600 ring-rose-600/15 dark:bg-rose-500/10 dark:text-rose-300", "alert"],
  run: ["Lauf", "bg-brand-50 text-brand-600 ring-brand-600/15 dark:bg-brand-500/10 dark:text-brand-300", "play"],
};
const loading = ref(true);

onMounted(async () => {
  try {
    entries.value = await api.log();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div v-if="error" class="alert alert-error mb-4"><Icon name="alert" class="mt-0.5" />{{ error }}</div>
  <div v-if="loading" class="card space-y-4 p-5"><div v-for="n in 6" :key="n" class="skeleton h-4" /></div>
  <div v-else-if="!entries.length" class="empty">
    <Icon name="history" :size="32" class="text-zinc-300 dark:text-zinc-600" />
    <p>Noch keine Einträge.</p>
  </div>
  <ol v-else class="card max-w-4xl divide-y divide-zinc-950/5 overflow-hidden dark:divide-white/5">
    <li v-for="e in entries" :key="e.id" class="flex gap-4 px-4 py-3.5 sm:px-5">
      <span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset" :class="labels[e.kind][1]" :title="labels[e.kind][0]">
        <Icon :name="labels[e.kind][2]" :size="15" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline gap-x-3">
          <a v-if="e.link" :href="e.link" target="_blank" class="min-w-0 truncate text-sm font-medium underline-offset-2 hover:underline">{{ e.subject }}</a>
          <p v-else class="min-w-0 truncate text-sm font-medium">{{ e.subject || labels[e.kind][0] }}</p>
          <time class="ml-auto shrink-0 text-xs tabular-nums text-zinc-500">{{ formatDate(e.ts) }}</time>
        </div>
        <p class="mt-0.5 text-xs text-zinc-500"><span class="font-medium">{{ labels[e.kind][0] }}</span><template v-if="e.detail"> · <span class="break-words">{{ e.detail }}</span></template></p>
      </div>
    </li>
  </ol>
</template>
