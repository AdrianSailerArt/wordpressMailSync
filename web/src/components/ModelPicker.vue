<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type ModelsResponse } from "../api";

/** Lokales Sprachmodell auswählen – gilt ab dem nächsten Entwurf. */
const emit = defineEmits<{ changed: [string] }>();

const data = ref<ModelsResponse | null>(null);
const error = ref("");
const saving = ref("");

async function load() {
  try {
    data.value = await api.models();
    error.value = data.value.error ?? "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function choose(name: string) {
  if (!data.value || name === data.value.current) return;
  saving.value = name;
  try {
    data.value.current = (await api.setModel(name)).current;
    emit("changed", data.value.current);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = "";
  }
}

const isCurrent = (name: string) => data.value?.current === name || data.value?.current === `${name}:latest`;

onMounted(load);
</script>

<template>
  <div>
    <p v-if="error" class="alert alert-error mb-3">{{ error }}</p>
    <p v-if="data?.provider === 'claude'" class="text-sm text-zinc-500">
      Es wird die Claude-API verwendet ({{ data.current }}). Lokale Modelle gibt es mit <code class="font-mono text-xs">LLM_PROVIDER=ollama</code>.
    </p>
    <template v-else-if="data">
      <ul class="divide-y divide-zinc-950/5 overflow-hidden rounded-xl ring-1 ring-zinc-950/5 dark:divide-white/5 dark:ring-white/10">
        <li v-for="m in data.models" :key="m.name">
          <button
            class="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-zinc-950/[0.025] disabled:cursor-default dark:hover:bg-white/[0.03]"
            :class="isCurrent(m.name) && 'bg-brand-50/60 dark:bg-brand-500/10'"
            :disabled="!!saving"
            @click="choose(m.name)"
          >
            <span
              class="flex size-4 shrink-0 items-center justify-center rounded-full border"
              :class="isCurrent(m.name) ? 'border-brand-600 dark:border-brand-400' : 'border-zinc-300 dark:border-zinc-600'"
            >
              <span v-if="isCurrent(m.name)" class="size-2 rounded-full bg-brand-600 dark:bg-brand-400" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">{{ m.name }}</span>
              <span class="block text-xs text-zinc-500">
                {{ m.params }} · {{ m.sizeGB }} GB · {{ m.quantization }}
                <template v-if="m.loaded"> · <span class="font-medium text-emerald-600 dark:text-emerald-400">geladen</span></template>
              </span>
            </span>
            <span v-if="m.tooBig" class="badge badge-amber shrink-0" :title="`Braucht mehr als ~70 % deiner ${data.ramGB} GB Arbeitsspeicher – sehr langsam`">
              zu groß für {{ data.ramGB }} GB
            </span>
            <span v-else-if="saving === m.name" class="shrink-0 text-xs text-zinc-500">speichert …</span>
          </button>
        </li>
      </ul>
      <p class="mt-2 text-xs text-zinc-500">
        Gilt ab dem nächsten Entwurf. Weitere Modelle installieren: <code class="font-mono">ollama pull &lt;name&gt;</code>
      </p>
    </template>
  </div>
</template>
