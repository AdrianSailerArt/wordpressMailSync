<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, formatDate, type LogEntry } from "../api";

const entries = ref<LogEntry[]>([]);
const error = ref("");

const labels: Record<LogEntry["kind"], [string, string]> = {
  published: ["Veröffentlicht", "bg-emerald-500"],
  suggested: ["Vorschlag", "bg-sky-500"],
  skipped: ["Übersprungen", "bg-zinc-300 dark:bg-zinc-700"],
  error: ["Fehler", "bg-rose-500"],
  run: ["Lauf", "bg-zinc-900 dark:bg-white"],
};

onMounted(async () => {
  try {
    entries.value = await api.log();
  } catch (e) {
    error.value = (e as Error).message;
  }
});
</script>

<template>
  <p v-if="error" class="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">{{ error }}</p>
  <p v-if="!entries.length" class="text-sm text-zinc-500">Noch keine Einträge.</p>
  <ol v-else class="max-w-3xl divide-y divide-zinc-100 text-sm dark:divide-zinc-900">
    <li v-for="e in entries" :key="e.id" class="grid grid-cols-[8.5rem_1fr] gap-4 py-3">
      <time class="text-xs tabular-nums text-zinc-500">{{ formatDate(e.ts) }}</time>
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="size-1.5 shrink-0 rounded-full" :class="labels[e.kind][1]" />
          <span class="text-xs text-zinc-500">{{ labels[e.kind][0] }}</span>
        </div>
        <a v-if="e.link" :href="e.link" target="_blank" class="mt-0.5 block truncate font-medium underline-offset-2 hover:underline">{{ e.subject }}</a>
        <p v-else-if="e.subject" class="mt-0.5 truncate font-medium">{{ e.subject }}</p>
        <p v-if="e.detail" class="mt-0.5 break-words text-zinc-500">{{ e.detail }}</p>
      </div>
    </li>
  </ol>
</template>
