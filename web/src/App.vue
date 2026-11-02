<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { api, formatDate, type RunResult, type Status } from "./api";
import InboxView from "./components/InboxView.vue";
import LogList from "./components/LogList.vue";

type Tab = "inbox" | "log" | "settings";

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
  <header class="top">
    <div class="brand">
      <span class="logo">🎸</span>
      <div>
        <strong>WordPress Mail Sync</strong>
        <div class="muted small">{{ status?.config.site ?? "…" }}</div>
      </div>
    </div>

    <div class="stats" v-if="status">
      <div class="stat">
        <span class="muted small">Heute</span>
        <span class="value" :class="{ full: status.today >= status.limit }">{{ status.today }} / {{ status.limit }}</span>
      </div>
      <div class="stat">
        <span class="muted small">Nächster Lauf</span>
        <span class="value">{{ formatDate(status.nextRun) }}</span>
      </div>
    </div>

    <div class="row">
      <button :disabled="running" @click="run(true)">Testlauf</button>
      <button class="primary" :disabled="running || (status ? status.today >= status.limit : true)" @click="run(false)">
        {{ running ? "Läuft …" : "Jetzt ausführen" }}
      </button>
    </div>
  </header>

  <main>
    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="runResult" class="card result">
      <div class="row" style="justify-content: space-between">
        <strong>{{ runResult.dryRun ? "Testlauf" : "Lauf" }}: {{ runResult.message }}</strong>
        <button @click="runResult = null">Schließen</button>
      </div>
      <ul v-if="runResult.published.length">
        <li v-for="p in runResult.published" :key="p.link"><a :href="p.link" target="_blank">{{ p.title }}</a></li>
      </ul>
      <article v-for="a in runResult.previews" :key="a.slug" class="preview">
        <h2>{{ a.title }}</h2>
        <p class="muted small">{{ a.meta_description }}</p>
        <div v-html="a.content_html" />
      </article>
    </div>

    <nav class="tabs">
      <button :class="{ active: tab === 'inbox' }" @click="tab = 'inbox'">Postfach</button>
      <button :class="{ active: tab === 'log' }" @click="tab = 'log'">Verlauf</button>
      <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">Einstellungen</button>
    </nav>

    <InboxView v-if="tab === 'inbox'" :key="'inbox' + refreshKey" :status="status" @changed="onChanged" />
    <LogList v-else-if="tab === 'log'" :key="'log' + refreshKey" />
    <section v-else-if="status" class="card settings">
      <p class="muted">Einstellungen kommen aus der <code>.env</code>-Datei des Servers.</p>
      <dl>
        <dt>WordPress</dt><dd><a :href="status.config.wpUrl" target="_blank">{{ status.config.wpUrl }}</a> · Status „{{ status.config.wpStatus }}“</dd>
        <dt>IMAP-Ordner</dt><dd>{{ status.config.folder }}</dd>
        <dt>Zeitplan</dt><dd><code>{{ status.schedule }}</code> ({{ status.config.timezone }}), max. {{ status.config.perRun }} pro Lauf, {{ status.limit }} pro Tag</dd>
        <dt>Sprachmodell</dt><dd>{{ status.config.model }}</dd>
        <dt>SEO-Plugin</dt><dd>{{ status.config.seoPlugin }}</dd>
        <dt>Kategorien</dt><dd>{{ status.config.categories.join(", ") }}</dd>
      </dl>
    </section>
  </main>
</template>

<style scoped>
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; gap: 10px; align-items: center; }
.logo { font-size: 26px; }
.small { font-size: 12px; }
.stats { display: flex; gap: 28px; }
.stat { display: flex; flex-direction: column; }
.stat .value { font-weight: 600; font-variant-numeric: tabular-nums; }
.stat .value.full { color: var(--warn); }
main { max-width: 1200px; margin: 0 auto; padding: 20px 24px 60px; }
.tabs { display: flex; gap: 4px; margin: 0 0 16px; border-bottom: 1px solid var(--border); }
.tabs button { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 8px 14px; color: var(--muted); }
.tabs button.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.result { margin-bottom: 20px; }
.preview { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 4px; }
.settings dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px; margin: 0; }
.settings dt { color: var(--muted); }
.settings dd { margin: 0; }
@media (max-width: 640px) {
  .top, main { padding-left: 16px; padding-right: 16px; }
  .settings dl { grid-template-columns: 1fr; }
}
</style>
