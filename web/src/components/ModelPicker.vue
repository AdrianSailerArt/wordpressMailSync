<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type LlmProvider, type ModelsResponse } from "../api";

/** Anbieter (Ollama, MLX, Claude) und Modell wählen – gilt ab dem nächsten Entwurf und Kalender-Abruf. */
const emit = defineEmits<{ changed: [string] }>();

const data = ref<ModelsResponse | null>(null);
const error = ref("");
const saving = ref("");
const loading = ref(false);

/** Modelle eines Anbieters laden – umgeschaltet wird erst mit der Wahl eines Modells */
async function load(provider?: LlmProvider) {
  loading.value = true;
  try {
    data.value = await api.models(provider);
    error.value = data.value.error ?? "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function choose(name: string) {
  if (!data.value || (isActive(data.value.provider) && isCurrent(name))) return;
  saving.value = name;
  try {
    const res = await api.setModel(data.value.provider, name);
    data.value = { ...data.value, active: res.provider, activeModel: res.current, current: res.current };
    emit("changed", res.current);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = "";
  }
}

const isActive = (provider: LlmProvider) => data.value?.active === provider;
const isCurrent = (name: string) => data.value?.current === name || data.value?.current === `${name}:latest`;
/** Häkchen nur beim Modell, das gerade schreibt */
const isChosen = (name: string) => !!data.value && isActive(data.value.provider) && isCurrent(name);

const HINT: Record<LlmProvider, string> = {
  ollama: "Ollama-App starten · Modelle installieren: ollama pull <name>",
  mlx: "Server starten: mlx_lm.server --port 8080 · Modelle laden: hf download mlx-community/<name>",
  opencode: "Server starten: opencode serve --port 4096 · Anbieter einrichten: opencode auth login",
  openai: "OpenAI-API · OPENAI_API_KEY in der .env (platform.openai.com) · Abrechnung nach Tokens",
  claude: "Claude-API · ANTHROPIC_API_KEY in der .env",
};

onMounted(() => load());
</script>

<template>
  <div>
    <div v-if="data" class="mb-4 flex flex-wrap items-center gap-3">
      <div class="segmented" role="group" aria-label="Anbieter">
        <button
          v-for="p in data.providers"
          :key="p.id"
          :aria-pressed="data.provider === p.id"
          :disabled="!p.available || loading"
          :title="p.available ? '' : `${p.id === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} fehlt in der .env`"
          class="disabled:cursor-not-allowed disabled:opacity-40"
          @click="load(p.id)"
        >
          {{ p.label }}
          <span v-if="isActive(p.id)" class="ml-1 inline-block size-1.5 rounded-full bg-emerald-500 align-middle" title="aktiv" />
        </button>
      </div>
      <span class="text-xs text-zinc-500">
        aktiv: <span class="font-medium text-zinc-700 dark:text-zinc-300">{{ data.providers.find((p) => p.id === data!.active)?.label }} · {{ data.activeModel }}</span>
      </span>
    </div>

    <p v-if="error" class="alert alert-error mb-3">{{ error }}</p>

    <template v-if="data">
      <ul
        v-if="data.models.length"
        class="divide-y divide-zinc-950/5 overflow-hidden rounded-xl ring-1 ring-zinc-950/5 transition-opacity dark:divide-white/5 dark:ring-white/10"
        :class="loading && 'opacity-50'"
      >
        <li v-for="m in data.models" :key="m.name">
          <button
            class="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-zinc-950/[0.025] disabled:cursor-default dark:hover:bg-white/[0.03]"
            :class="isChosen(m.name) && 'bg-brand-50/60 dark:bg-brand-500/10'"
            :disabled="!!saving || loading"
            @click="choose(m.name)"
          >
            <span
              class="flex size-4 shrink-0 items-center justify-center rounded-full border"
              :class="isChosen(m.name) ? 'border-brand-600 dark:border-brand-400' : 'border-zinc-300 dark:border-zinc-600'"
            >
              <span v-if="isChosen(m.name)" class="size-2 rounded-full bg-brand-600 dark:bg-brand-400" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ m.name }}</span>
              <span class="block text-xs text-zinc-500">
                {{ [m.params, m.sizeGB ? `${m.sizeGB} GB` : "", m.quantization, m.family].filter(Boolean).join(" · ") || data.providers.find((p) => p.id === data!.provider)?.label }}
                <template v-if="m.loaded"> · <span class="font-medium text-emerald-600 dark:text-emerald-400">geladen</span></template>
                <template v-if="!isActive(data.provider) && isCurrent(m.name)"> · zuletzt gewählt</template>
              </span>
            </span>
            <span v-if="m.tooBig" class="badge badge-amber shrink-0" :title="`Braucht mehr als ~70 % deiner ${data.ramGB} GB Arbeitsspeicher – sehr langsam`">
              zu groß für {{ data.ramGB }} GB
            </span>
            <span v-else-if="saving === m.name" class="shrink-0 text-xs text-zinc-500">speichert …</span>
          </button>
        </li>
      </ul>
      <p v-else-if="!error && !loading" class="text-sm text-zinc-500">Keine Modelle gefunden.</p>
      <p class="mt-2 text-xs text-zinc-500">
        Ein Klick auf ein Modell schaltet um – gilt ab dem nächsten Entwurf und Kalender-Abruf.
        <span class="block font-mono text-[11px] text-zinc-400">{{ HINT[data.provider] }}</span>
      </p>
    </template>
  </div>
</template>
