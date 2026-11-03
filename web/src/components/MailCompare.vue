<script setup lang="ts">
import { diffWords } from "diff";
import { computed, ref } from "vue";
import { htmlToPlain } from "../facts";

/** Wortweiser Vergleich Original-Mail ↔ generierter Beitrag. */
const props = defineProps<{ original: string; html: string; title: string }>();

const layout = ref<"inline" | "split">("split");

const generated = computed(() => `${props.title}\n\n${htmlToPlain(props.html)}`);
const parts = computed(() => diffWords(props.original.trim(), generated.value, { ignoreCase: true }));

/** Anteil der Wörter des Beitrags, die wörtlich aus der Mail stammen. */
const kept = computed(() => {
  const count = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const same = parts.value.filter((p) => !p.added && !p.removed).reduce((n, p) => n + count(p.value), 0);
  const total = parts.value.filter((p) => !p.removed).reduce((n, p) => n + count(p.value), 0);
  return total ? Math.round((same / total) * 100) : 0;
});
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500">
      <span class="flex items-center gap-1.5"><span class="size-2 rounded-sm bg-rose-200 dark:bg-rose-900" /> nur im Original</span>
      <span class="flex items-center gap-1.5"><span class="size-2 rounded-sm bg-emerald-200 dark:bg-emerald-900" /> neu im Beitrag</span>
      <span class="badge badge-brand tabular-nums">{{ kept }} % wörtlich übernommen</span>
      <div class="segmented ml-auto">
        <button
          v-for="[id, label] in ([['split', 'Nebeneinander'], ['inline', 'Zusammen']] as const)"
          :key="id"
          :aria-pressed="layout === id"
          @click="layout = id"
        >
          {{ label }}
        </button>
      </div>
    </div>

    <div v-if="layout === 'split'" class="grid gap-4 md:grid-cols-2">
      <div v-for="side in (['removed', 'added'] as const)" :key="side" class="min-w-0">
        <p class="eyebrow mb-2">{{ side === "removed" ? "Original-Mail" : "Beitrag" }}</p>
        <div class="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-950/[0.015] p-4 text-sm leading-relaxed ring-1 ring-zinc-950/5 dark:bg-white/[0.02] dark:ring-white/10">
          <template v-for="(p, i) in parts" :key="i">
            <span v-if="!p.added && !p.removed">{{ p.value }}</span>
            <mark v-else-if="side === 'removed' && p.removed" class="rounded-sm bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">{{ p.value }}</mark>
            <mark v-else-if="side === 'added' && p.added" class="rounded-sm bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{{ p.value }}</mark>
          </template>
        </div>
      </div>
    </div>

    <div v-else class="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-950/[0.015] p-4 text-sm leading-relaxed ring-1 ring-zinc-950/5 dark:bg-white/[0.02] dark:ring-white/10">
      <template v-for="(p, i) in parts" :key="i">
        <!-- Leerzeichen anhängen, damit Gelöschtes nicht am folgenden Wort klebt -->
        <del v-if="p.removed" class="rounded-sm bg-rose-100 text-rose-900 decoration-rose-400 dark:bg-rose-950 dark:text-rose-200">{{ /\s$/.test(p.value) ? p.value : p.value + " " }}</del>
        <ins v-else-if="p.added" class="rounded-sm bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-950 dark:text-emerald-200">{{ p.value }}</ins>
        <span v-else>{{ p.value }}</span>
      </template>
    </div>
  </div>
</template>
