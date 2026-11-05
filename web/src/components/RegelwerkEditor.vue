<script setup lang="ts">
/**
 * Stil-Regelwerk bearbeiten. Die Datei stil/regelwerk.md bleibt unverändert als Vorlage –
 * gespeichert wird eine eigene Fassung, „Auf Vorlage zurücksetzen“ nimmt wieder die Datei.
 */
import { diffLines } from "diff";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, formatDate, type RegelwerkState } from "../api";
import Icon from "./Icon.vue";

const state = ref<RegelwerkState | null>(null);
const text = ref("");
const view = ref<"edit" | "diff" | "template">("edit");
const saving = ref(false);
const error = ref("");
const ok = ref("");
const area = ref<HTMLTextAreaElement | null>(null);

async function load() {
  try {
    state.value = await api.regelwerk();
    text.value = state.value.text;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

const dirty = computed(() => !!state.value && text.value !== state.value.text);
const differsFromTemplate = computed(() => !!state.value && text.value.trim() !== state.value.template.trim());

// ungespeicherte Änderungen nicht beim Verlassen verlieren
const beforeUnload = (e: BeforeUnloadEvent) => {
  if (dirty.value) e.preventDefault();
};
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onBeforeUnmount(() => window.removeEventListener("beforeunload", beforeUnload));

/** Gliederung: ## Überschriften mit Zeilennummer – „## Aufbau: … (tour)“ gilt nur für diese Meldungsart */
const ART: Record<string, string> = { tour: "nur Tour", album: "nur Album/Single/Video", festival: "nur Festival", konzert: "nur Einzelkonzert", sonstiges: "nur Sonstiges" };
const outline = computed(() =>
  text.value.split("\n").flatMap((line, i) => {
    const m = line.match(/^##\s+(.+)$/);
    if (!m) return [];
    const art = m[1]!.match(/^Aufbau:.*\((\w+)\)\s*$/)?.[1];
    return [{ line: i, title: m[1]!.replace(/\s*\(\w+\)\s*$/, ""), note: art ? ART[art] ?? `nur ${art}` : /^Aufbau nach Art/.test(m[1]!) ? "nur für Menschen" : "" }];
  }),
);

function jump(line: number) {
  const el = area.value;
  if (!el) return;
  const pos = text.value.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0);
  el.focus();
  el.setSelectionRange(pos, pos);
  // grob an die Stelle scrollen: Zeilenhöhe × Zeile
  el.scrollTop = Math.max(0, line * parseFloat(getComputedStyle(el).lineHeight || "20") - 40);
}

const diff = computed(() => (state.value ? diffLines(state.value.template, text.value) : []));
const diffStats = computed(() => {
  let added = 0;
  let removed = 0;
  for (const d of diff.value) {
    if (d.added) added += d.count ?? 0;
    if (d.removed) removed += d.count ?? 0;
  }
  return { added, removed };
});

async function act(fn: () => Promise<RegelwerkState>, message: string) {
  saving.value = true;
  error.value = "";
  try {
    state.value = await fn();
    text.value = state.value.text;
    ok.value = message;
    setTimeout(() => (ok.value = ""), 3000);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
const save = () => act(() => api.saveRegelwerk(text.value), "gespeichert – gilt ab dem nächsten Entwurf");
async function reset() {
  if (!confirm("Eigene Fassung verwerfen und wieder die Vorlage (stil/regelwerk.md) verwenden?")) return;
  await act(() => api.resetRegelwerk(), "Vorlage gilt wieder");
}
const discard = () => state.value && (text.value = state.value.text);

/** ⌘S / Strg+S speichert */
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    if (dirty.value) save();
  }
}
</script>

<template>
  <section class="card overflow-hidden">
    <div class="card-header">
      <Icon name="pencil" class="text-zinc-400" />
      <h2 class="text-sm font-semibold">Stil-Regelwerk</h2>
      <span v-if="state" class="badge" :class="state.custom ? 'badge-brand' : ''">{{ state.custom ? "eigene Fassung" : "Vorlage" }}</span>
      <span v-if="state?.custom && state.updatedAt" class="text-xs text-zinc-500">geändert {{ formatDate(state.updatedAt) }}</span>
      <span class="ml-auto" />
      <div class="segmented">
        <button :aria-pressed="view === 'edit'" @click="view = 'edit'">Bearbeiten</button>
        <button :aria-pressed="view === 'diff'" :disabled="!differsFromTemplate" @click="view = 'diff'">
          Unterschiede<template v-if="differsFromTemplate"> <span class="text-emerald-600">+{{ diffStats.added }}</span> <span class="text-brand-600">−{{ diffStats.removed }}</span></template>
        </button>
        <button :aria-pressed="view === 'template'" @click="view = 'template'">Vorlage</button>
      </div>
    </div>

    <p class="border-b border-zinc-950/15 px-4 py-2.5 text-xs text-zinc-600 dark:border-white/10 dark:text-zinc-400">
      Geht in jeden Schreibauftrag ans Sprachmodell (Markdown). Abschnitte <code class="font-mono">## Aufbau: … (tour)</code> gelten nur für diese Meldungsart.
      Die Datei <code class="font-mono">stil/regelwerk.md</code> bleibt als Vorlage unverändert.
    </p>

    <div v-if="!state" class="card-body"><div class="skeleton h-64 w-full" /></div>

    <!-- Bearbeiten -->
    <div v-else-if="view === 'edit'" class="grid lg:grid-cols-[14rem_minmax(0,1fr)]">
      <nav class="hidden max-h-[36rem] overflow-y-auto border-r border-zinc-950/15 p-2 lg:block dark:border-white/10" aria-label="Gliederung">
        <button
          v-for="h in outline"
          :key="h.line"
          class="block w-full cursor-pointer border-l-2 border-transparent px-2 py-1 text-left text-xs hover:border-zinc-950 dark:hover:border-white"
          @click="jump(h.line)"
        >
          <span class="block font-semibold">{{ h.title }}</span>
          <span v-if="h.note" class="block text-[10px] text-zinc-500">{{ h.note }}</span>
        </button>
      </nav>
      <textarea
        ref="area"
        v-model="text"
        class="block h-[36rem] w-full resize-y bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none"
        spellcheck="true"
        lang="de"
        aria-label="Stil-Regelwerk (Markdown)"
        @keydown="onKey"
      />
    </div>

    <!-- Unterschiede zur Vorlage -->
    <div v-else-if="view === 'diff'" class="max-h-[36rem] overflow-y-auto p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
      <template v-for="(d, i) in diff" :key="i">
        <div v-if="d.added" class="border-l-4 border-emerald-600 bg-emerald-50 pl-2 dark:bg-emerald-500/10">{{ d.value }}</div>
        <div v-else-if="d.removed" class="border-l-4 border-brand-600 bg-brand-50 pl-2 line-through decoration-brand-600/40 dark:bg-brand-500/10">{{ d.value }}</div>
        <div v-else class="pl-3 text-zinc-500">{{ d.value.split("\n").length > 7 ? d.value.split("\n").slice(0, 2).join("\n") + "\n  ⋯\n" + d.value.split("\n").slice(-3).join("\n") : d.value }}</div>
      </template>
    </div>

    <!-- Vorlage (nur lesen) -->
    <div v-else class="max-h-[36rem] overflow-y-auto p-4">
      <pre class="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{{ state.template }}</pre>
    </div>

    <div v-if="state" class="flex flex-wrap items-center gap-2 border-t border-zinc-950 px-4 py-3 dark:border-white/30">
      <button class="btn btn-primary btn-sm" :disabled="saving || !dirty" title="⌘S" @click="save"><Icon name="save" :size="12" />Speichern</button>
      <button v-if="dirty" class="btn btn-ghost btn-sm" @click="discard">Verwerfen</button>
      <button v-if="view === 'template'" class="btn btn-sm" @click="text = state.template; view = 'edit'">
        <Icon name="copy" :size="12" />Vorlage in den Editor
      </button>
      <span v-if="ok" class="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><Icon name="check" :size="12" />{{ ok }}</span>
      <span v-else-if="dirty" class="text-xs text-zinc-500">ungespeicherte Änderungen</span>
      <span class="mr-auto" />
      <button v-if="state.custom" class="btn btn-ghost btn-danger btn-sm" :disabled="saving" @click="reset">
        <Icon name="history" :size="12" />Auf Vorlage zurücksetzen
      </button>
    </div>
    <p v-if="error" class="alert alert-error m-4 mt-0 text-xs"><Icon name="alert" :size="14" class="mt-0.5" />{{ error }}</p>
  </section>
</template>
