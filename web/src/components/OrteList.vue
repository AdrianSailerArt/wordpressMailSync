<script setup lang="ts">
/** Orte im Gebiet (Ort → Land) – Veranstalter wie Vaddi werden auf diese Orte beschränkt. */
import { computed, ref } from "vue";
import { api } from "../api";
import Icon from "./Icon.vue";

const props = defineProps<{ orte: Record<string, string>; usedBy: Record<string, string[]> }>();
const emit = defineEmits<{ changed: [] }>();

const name = ref("");
const land = ref("DE");
const busy = ref(false);
const error = ref("");

const LAENDER = ["DE", "CH", "FR", "AT"];
const LAND_NAME: Record<string, string> = { DE: "Deutschland", CH: "Schweiz", FR: "Frankreich", AT: "Österreich" };

const groups = computed(() => {
  const by = new Map<string, string[]>();
  for (const [ort, l] of Object.entries(props.orte)) by.set(l, [...(by.get(l) ?? []), ort]);
  return [...by].sort(([a], [b]) => (LAENDER.indexOf(a) + 1 || 99) - (LAENDER.indexOf(b) + 1 || 99))
    .map(([l, orte]) => ({ land: l, orte: orte.sort((a, b) => a.localeCompare(b, "de")) }));
});
const exists = computed(() => Object.keys(props.orte).find((o) => o.toLowerCase() === name.value.trim().toLowerCase()));

async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = "";
  try {
    await fn();
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const add = () => act(async () => {
  await api.setOrt(name.value, land.value);
  name.value = "";
});
const remove = (ort: string) => act(() => api.deleteOrt(ort));
</script>

<template>
  <div>
    <form class="space-y-2 border-b border-zinc-950 p-4 dark:border-white/30" @submit.prevent="add">
      <div class="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
        <input v-model="name" class="field" placeholder="Neuer Ort, z. B. Kandern" aria-label="Ort" required />
        <select v-model="land" class="field" aria-label="Land">
          <option v-for="l in LAENDER" :key="l">{{ l }}</option>
        </select>
      </div>
      <button type="submit" class="btn btn-sm w-full" :disabled="busy || !name.trim()">
        <Icon name="plus" :size="12" />{{ exists ? `Land von „${exists}“ ändern` : "Ort hinzufügen" }}
      </button>
      <p class="text-[11px] text-zinc-500">Termine von Veranstaltern mit Konzerten in ganz Deutschland (Vaddi) kommen nur aus diesen Orten in den Kalender.</p>
      <p v-if="error" class="alert alert-error text-xs"><Icon name="alert" :size="14" class="mt-0.5" />{{ error }}</p>
    </form>

    <div class="max-h-96 overflow-y-auto p-4 xl:max-h-[calc(100dvh-20rem)]">
      <section v-for="g in groups" :key="g.land" class="mb-4 last:mb-0">
        <p class="eyebrow mb-2">{{ LAND_NAME[g.land] ?? g.land }} <span class="text-zinc-500">{{ g.orte.length }}</span></p>
        <ul class="flex flex-wrap gap-1.5">
          <li v-for="o in g.orte" :key="o" class="inline-flex items-center border border-zinc-950/40 text-xs dark:border-white/30">
            <span class="py-1 pl-2" :class="usedBy[o] ? 'pr-1 font-semibold' : 'pr-1'" :title="usedBy[o] ? `Locations: ${usedBy[o].join(', ')}` : undefined">{{ o }}</span>
            <button
              type="button"
              class="px-1.5 py-1 text-zinc-400 hover:bg-zinc-950 hover:text-white disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-white dark:hover:text-zinc-950"
              :disabled="busy || !!usedBy[o]"
              :title="usedBy[o] ? `Wird von ${usedBy[o].join(', ')} genutzt` : `${o} entfernen`"
              @click="remove(o)"
            ><Icon name="x" :size="11" /></button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
