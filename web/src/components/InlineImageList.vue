<script setup lang="ts">
/** Bilder im Text: für jedes Bild die Stelle wählen („nach Absatz n“), oder es wieder herausnehmen. */
import { computed } from "vue";
import { paragraphSnippets } from "../../../shared/paragraphs";
import Icon from "./Icon.vue";

const props = defineProps<{
  ids: string[];
  /** Bild-ID → nach diesem Absatz; fehlt = 1 */
  positions: Record<string, number>;
  contentHtml: string;
  /** Vorschaubild und Beschreibung je Bild-ID */
  srcOf: (id: string) => string;
  labelOf: (id: string) => string;
}>();
const emit = defineEmits<{ move: [id: string, after: number]; remove: [id: string] }>();

const snippets = computed(() => paragraphSnippets(props.contentHtml));
const options = computed(() => [
  { value: 0, label: "Ganz oben, vor dem ersten Absatz" },
  ...snippets.value.map((text, i) => ({ value: i + 1, label: `Nach Absatz ${i + 1}: „${text || "…"}“` })),
]);
/** zu große Positionen (Text gekürzt) zeigen, wo das Bild wirklich landet: hinter dem letzten Absatz */
const positionOf = (id: string) => Math.min(props.positions[id] ?? 1, snippets.value.length);
</script>

<template>
  <div v-if="ids.length" class="mt-6">
    <div class="label"><span>Bilder im Text</span><span class="font-normal text-zinc-400">Stelle je Bild wählen · Vorschau im Reiter „Beitrag“</span></div>
    <ul class="space-y-2">
      <li v-for="id in ids" :key="id" class="flex items-center gap-3 border border-zinc-950/30 p-2 dark:border-white/20">
        <img v-if="srcOf(id)" :src="srcOf(id)" alt="" class="size-12 shrink-0 bg-zinc-100 object-cover dark:bg-zinc-800" />
        <span v-else class="skeleton size-12 shrink-0" />
        <div class="min-w-0 flex-1">
          <label :for="`pos-${id}`" class="block truncate text-xs text-zinc-500">{{ labelOf(id) }}</label>
          <select :id="`pos-${id}`" class="field mt-0.5 !py-1.5 text-sm" :value="positionOf(id)" @change="emit('move', id, Number(($event.target as HTMLSelectElement).value))">
            <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <button type="button" class="btn btn-sm shrink-0" :aria-label="`${labelOf(id)} aus dem Text nehmen`" title="Aus dem Text nehmen" @click="emit('remove', id)">
          <Icon name="x" :size="13" />
        </button>
      </li>
    </ul>
  </div>
</template>
