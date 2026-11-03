<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { api, formatDate, type RunResult, type Status } from "./api";
import InboxView from "./components/InboxView.vue";
import LogList from "./components/LogList.vue";

type Tab = "inbox" | "log" | "settings";
const tabs: { id: Tab; label: string }[] = [
  { id: "inbox", label: "Postfach" },
  { id: "log", label: "Verlauf" },
  { id: "settings", label: "Einstellungen" },
];

const tab = ref<Tab>("inbox");
const status = ref<Status | null>(null);
const error = ref("");
const running = ref(false);
const runResult = ref<RunResult | null>(null);
const refreshKey = ref(0);

async function loadStatus() {
  try {
    status.value = await api.status();
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function run(dryRun: boolean) {
  running.value = true;
  runResult.value = null;
  try {
    runResult.value = await api.run(dryRun);
    refreshKey.value++;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    running.value = false;
    loadStatus();
  }
}

// Das Postfach aktualisiert seine Liste selbst – hier nur den Tageszähler neu laden
const onChanged = loadStatus;

let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  loadStatus();
  timer = setInterval(loadStatus, 60_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 sm:px-6">
    <header class="flex flex-wrap items-center gap-x-6 gap-y-3 py-5">
      <div class="mr-auto">
        <h1 class="text-sm font-semibold tracking-tight">Mail Sync</h1>
        <p class="text-xs text-zinc-500">{{ status?.config.site ?? "…" }}</p>
      </div>

      <dl v-if="status" class="flex gap-6 text-xs">
        <div>
          <dt class="text-zinc-500">Heute</dt>
          <dd class="font-medium tabular-nums" :class="status.today >= status.limit && 'text-amber-600 dark:text-amber-400'">
            {{ status.today }} / {{ status.limit }}
          </dd>
        </div>
        <div>
          <dt class="text-zinc-500">Nächster Lauf</dt>
          <dd class="font-medium tabular-nums">{{ formatDate(status.nextRun) }}</dd>
        </div>
      </dl>

      <div class="flex gap-1">
        <button class="btn" :disabled="running" @click="run(true)">Testlauf</button>
        <button class="btn btn-primary" :disabled="running || !status || status.today >= status.limit" @click="run(false)">
          {{ running ? "Läuft …" : "Ausführen" }}
        </button>
      </div>
    </header>

    <nav class="flex gap-5 border-b border-zinc-200 text-sm dark:border-zinc-800">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="-mb-px border-b py-2 transition-colors"
        :class="tab === t.id ? 'border-zinc-900 text-zinc-900 dark:border-white dark:text-white' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </nav>

    <main class="py-6">
      <p v-if="error" class="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">{{ error }}</p>

      <section v-if="runResult" class="mb-6 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <div class="flex items-start justify-between gap-4">
          <p><span class="text-zinc-500">{{ runResult.dryRun ? "Testlauf" : "Lauf" }} ·</span> {{ runResult.message }}</p>
          <button class="btn -my-1.5 -mr-2" @click="runResult = null">Schließen</button>
        </div>
        <ul v-if="runResult.published.length" class="mt-2 space-y-1">
          <li v-for="p in runResult.published" :key="p.link"><a :href="p.link" target="_blank" class="underline underline-offset-2">{{ p.title }}</a></li>
        </ul>
        <article v-for="a in runResult.previews" :key="a.slug" class="prose prose-sm prose-zinc mt-4 max-w-none border-t border-zinc-200 pt-4 dark:prose-invert dark:border-zinc-800">
          <h2 class="!mt-0">{{ a.title }}</h2>
          <div v-html="a.content_html" />
        </article>
      </section>

      <InboxView v-if="tab === 'inbox'" :key="'inbox' + refreshKey" :status="status" @changed="onChanged" />
      <LogList v-else-if="tab === 'log'" :key="'log' + refreshKey" />
      <section v-else-if="status" class="max-w-xl text-sm">
        <p class="mb-6 text-zinc-500">Werte aus der <code class="font-mono text-xs">.env</code> des Servers.</p>
        <dl class="divide-y divide-zinc-100 dark:divide-zinc-900">
          <div v-for="[k, v] in ([
            ['WordPress', `${status.config.wpUrl} · ${status.config.wpStatus}`],
            ['IMAP-Ordner', status.config.folder],
            ['Zeitplan', `${status.schedule} (${status.config.timezone})`],
            ['Limit', `${status.config.perRun} pro Lauf, ${status.limit} pro Tag`],
            ['Sprachmodell', status.config.model],
            ['SEO-Plugin', status.config.seoPlugin],
            ['Kategorien', status.config.categories.join(', ')],
          ] as const)" :key="k" class="grid grid-cols-3 gap-4 py-2.5">
            <dt class="text-zinc-500">{{ k }}</dt>
            <dd class="col-span-2 break-words">{{ v }}</dd>
          </div>
        </dl>
      </section>
    </main>
  </div>
</template>
