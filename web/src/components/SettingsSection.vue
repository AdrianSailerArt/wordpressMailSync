<script setup lang="ts">
/**
 * Ein Abschnitt der Einstellungen: Felder mit Pfad („limits.schedule“), eigener Speichern-Knopf.
 * Gespeichert wird nur, was sich geändert hat; Geheimnisse bleiben leer und gelten dann als unverändert.
 */
import { computed, reactive, ref, watch } from "vue";
import { api, type Setup, type SetupInput } from "../api";
import type { IconName } from "../icons";
import Icon from "./Icon.vue";

export interface Field {
  path: string;
  label: string;
  type: "text" | "textarea" | "number" | "toggle" | "select" | "secret" | "cron";
  hint?: string;
  options?: [string, string][];
  placeholder?: string;
  /** Pfad des „ist gesetzt“-Flags bei Geheimnissen, z. B. „server.hasPassword“ */
  isSet?: string;
  /** volle Breite im Raster */
  wide?: boolean;
  min?: number;
  max?: number;
}

const props = defineProps<{ title: string; icon: IconName; setup: Setup; fields: Field[]; badge?: string }>();
const emit = defineEmits<{ saved: [setup: Setup] }>();

const get = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], obj);
const initial = () => Object.fromEntries(props.fields.map((f) => [f.path, f.type === "secret" ? "" : get(props.setup, f.path)]));

const values = reactive<Record<string, unknown>>(initial());
watch(() => props.setup, () => Object.assign(values, initial()));

const changed = computed(() => props.fields.filter((f) => (f.type === "secret" ? values[f.path] !== "" : values[f.path] !== get(props.setup, f.path))));
const saving = ref(false);
const error = ref("");
const ok = ref(false);

function patch(entries: [string, unknown][]): SetupInput {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [path, v] of entries) {
    const [section, key] = path.split(".") as [string, string];
    (out[section] ??= {})[key] = v;
  }
  return out as SetupInput;
}

async function save(entries = changed.value.map((f) => [f.path, f.type === "number" ? Number(values[f.path]) : values[f.path]] as [string, unknown])) {
  if (!entries.length) return;
  saving.value = true;
  error.value = "";
  try {
    const s = await api.saveSetup(patch(entries));
    emit("saved", s);
    ok.value = true;
    setTimeout(() => (ok.value = false), 2500);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
const clearSecret = (f: Field) => save([[f.path, null]]);
const reset = () => Object.assign(values, initial());
</script>

<template>
  <section class="card">
    <div class="card-header">
      <Icon :name="icon" class="text-zinc-400" />
      <h2 class="text-sm font-semibold">{{ title }}</h2>
      <span v-if="badge" class="badge">{{ badge }}</span>
      <span class="ml-auto" />
      <slot name="actions" />
    </div>
    <slot name="before" />
    <form class="grid gap-x-3 gap-y-4 p-4 sm:grid-cols-2" @submit.prevent="save()">
      <div v-for="f in fields" :key="f.path" :class="(f.wide || f.type === 'textarea' || f.type === 'cron') && 'sm:col-span-2'">
        <!-- Schalter -->
        <label v-if="f.type === 'toggle'" class="flex cursor-pointer items-start gap-2.5 text-sm">
          <input v-model="values[f.path]" type="checkbox" class="mt-0.5" />
          <span>
            <span class="font-semibold">{{ f.label }}</span>
            <span v-if="f.hint" class="block text-xs text-zinc-500">{{ f.hint }}</span>
          </span>
        </label>

        <template v-else>
          <label class="label" :for="`f-${f.path}`">
            {{ f.label }}
            <span v-if="f.type === 'secret' && f.isSet" class="font-normal tracking-normal normal-case text-zinc-500">
              <template v-if="get(setup, f.isSet)">gesetzt · <button type="button" class="text-brand-700 underline underline-offset-2 dark:text-brand-300" @click="clearSecret(f)">entfernen</button></template>
              <template v-else>nicht gesetzt</template>
            </span>
          </label>
          <textarea v-if="f.type === 'textarea'" :id="`f-${f.path}`" v-model="values[f.path] as string" class="field min-h-20" :placeholder="f.placeholder" />
          <select v-else-if="f.type === 'select'" :id="`f-${f.path}`" v-model="values[f.path]" class="field">
            <option v-for="[v, l] in f.options" :key="v" :value="v">{{ l }}</option>
          </select>
          <input
            v-else
            :id="`f-${f.path}`"
            v-model="values[f.path]"
            class="field"
            :class="(f.type === 'cron' || f.type === 'secret') && 'font-mono'"
            :type="f.type === 'number' ? 'number' : f.type === 'secret' ? 'password' : 'text'"
            :min="f.min" :max="f.max"
            :autocomplete="f.type === 'secret' ? 'new-password' : 'off'"
            :placeholder="f.type === 'secret' ? (f.isSet && get(setup, f.isSet) ? 'gesetzt – leer lassen' : f.placeholder) : f.placeholder"
          />
          <p v-if="f.hint" class="mt-1 text-[11px] text-zinc-500">{{ f.hint }}</p>
        </template>
      </div>

      <slot />

      <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button type="submit" class="btn btn-primary btn-sm" :disabled="saving || !changed.length"><Icon name="save" :size="12" />Speichern</button>
        <button v-if="changed.length" type="button" class="btn btn-ghost btn-sm" @click="reset">Verwerfen</button>
        <span v-if="ok" class="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><Icon name="check" :size="12" />gespeichert – gilt sofort</span>
        <span v-else-if="changed.length" class="text-xs text-zinc-500">{{ changed.length }} {{ changed.length === 1 ? "Änderung" : "Änderungen" }}</span>
      </div>
      <p v-if="error" class="alert alert-error text-xs sm:col-span-2"><Icon name="alert" :size="14" class="mt-0.5" />{{ error }}</p>
    </form>
  </section>
</template>
