<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, formatDate, type RunResult, type Status } from "./api";
import type { IconName } from "./icons";
import { connectLive, live, stageLabel } from "./llm";
import { disablePush, enablePush, onOpenRequest, pushState, type PushState } from "./push";
import Icon from "./components/Icon.vue";
import InboxView from "./components/InboxView.vue";
import KalenderView from "./components/KalenderView.vue";
import LogList from "./components/LogList.vue";
import PageHeader from "./components/PageHeader.vue";
import SettingsView from "./components/SettingsView.vue";

type Tab = "postfach" | "kalender" | "verlauf" | "einstellungen";
const tabs: { id: Tab; label: string; icon: IconName; hint: string }[] = [
  { id: "postfach", label: "Postfach", icon: "inbox", hint: "Pressemitteilungen → Beiträge" },
  { id: "kalender", label: "Konzertkalender", icon: "calendar", hint: "Termine aus der Region" },
  { id: "verlauf", label: "Verlauf", icon: "history", hint: "Was zuletzt passiert ist" },
  { id: "einstellungen", label: "Einstellungen", icon: "settings", hint: "Modell und Konfiguration" },
];

// Reiter steht in der Adresse (#kalender …), damit er Neuladen und Zurück übersteht
const fromHash = (): Tab => (tabs.find((t) => `#${t.id}` === location.hash)?.id ?? "postfach");
const tab = ref<Tab>(fromHash());
watch(tab, (t) => {
  if (location.hash !== `#${t}`) history.pushState(null, "", `#${t}`);
});
const onHashChange = () => (tab.value = fromHash());

const status = ref<Status | null>(null);
const error = ref("");
const running = ref(false);
const runResult = ref<RunResult | null>(null);
const refreshKey = ref(0);
/** irgendein laufender Modell-Durchlauf (z. B. vom Zeitplan) – für die Anzeige in der Seitenleiste */
const activeRun = computed(() => Object.values(live.runs)[0] ?? null);
const push = ref<PushState>("off");
const suggesting = ref(false);
/** Mail, die per Benachrichtigung oder ?mail= geöffnet werden soll */
const openUid = ref<number | null>(Number(new URLSearchParams(location.search).get("mail")) || null);

/** „heute 21:00“, „morgen 08:00“ oder „Do 08:00“ – passt in die Seitenleiste */
function shortDate(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  return `${days === 0 ? "heute" : days === 1 ? "morgen" : d.toLocaleDateString("de-DE", { weekday: "short" })} ${time}`;
}

const todayShare = computed(() => (status.value ? Math.min(100, (status.value.today / Math.max(1, status.value.limit)) * 100) : 0));
const pushLabel = computed(() => ({
  on: "Benachrichtigungen an",
  off: "Benachrichtigungen aus",
  denied: "In Chrome blockiert",
  unsupported: "Nicht unterstützt",
})[push.value]);

async function togglePush() {
  try {
    push.value = push.value === "on" ? await disablePush() : await enablePush();
    if (push.value === "on") await api.testPush();
    loadStatus();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function suggestNow() {
  suggesting.value = true;
  try {
    const r = await api.suggest();
    runResult.value = { published: [], skipped: 0, dryRun: false, previews: [], message: r.message };
    if (r.suggested) openUid.value = r.suggested.uid;
    tab.value = "postfach";
    refreshKey.value++;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    suggesting.value = false;
  }
}

function openFromUrl(url: string) {
  const uid = Number(new URL(url, location.origin).searchParams.get("mail"));
  if (!uid) return;
  openUid.value = uid;
  tab.value = "postfach";
  refreshKey.value++;
}

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
  connectLive();
  pushState().then((s) => (push.value = s));
  onOpenRequest(openFromUrl);
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("popstate", onHashChange);
  if (openUid.value) history.replaceState(null, "", "/#postfach");
  timer = setInterval(loadStatus, 60_000);
});
onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener("hashchange", onHashChange);
  window.removeEventListener("popstate", onHashChange);
});
</script>

<template>
  <div class="min-h-dvh">
    <!-- Seitenleiste (ab lg) -->
    <aside class="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-zinc-950/5 bg-white/70 backdrop-blur-xl lg:flex dark:border-white/5 dark:bg-zinc-900/60">
      <div class="flex items-center gap-3 px-5 pt-6 pb-5">
        <img src="/icon.svg" alt="" class="size-9 rounded-[10px] shadow-sm shadow-brand-700/30" />
        <div class="min-w-0">
          <p class="text-[15px] font-semibold tracking-tight text-zinc-950 dark:text-white">Bühnenpost</p>
          <p class="truncate text-xs text-zinc-500">{{ status?.config.site ?? "…" }}</p>
        </div>
      </div>

      <nav class="flex-1 space-y-0.5 px-3">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition"
          :class="tab === t.id
            ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-200'
            : 'text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white'"
          :aria-current="tab === t.id ? 'page' : undefined"
          @click="tab = t.id"
        >
          <Icon :name="t.icon" :size="18" :class="tab === t.id ? 'text-brand-600 dark:text-brand-300' : 'text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300'" />
          <span class="min-w-0 flex-1">
            <span class="block">{{ t.label }}</span>
            <span class="block truncate text-[11px] font-normal" :class="tab === t.id ? 'text-brand-700/70 dark:text-brand-300/70' : 'text-zinc-400'">{{ t.hint }}</span>
          </span>
          <span v-if="t.id === 'postfach' && activeRun" class="size-2 animate-pulse rounded-full bg-emerald-500" title="Das Modell schreibt gerade" />
        </button>
      </nav>

      <!-- Status -->
      <div v-if="status" class="m-3 space-y-3 rounded-xl bg-zinc-950/[0.03] p-3 text-xs ring-1 ring-zinc-950/5 dark:bg-white/[0.03] dark:ring-white/5">
        <button
          class="flex w-full items-center gap-2.5 text-left"
          :title="activeRun ? `${stageLabel(activeRun.stage)} – klicken zum Ansehen` : 'Modell wechseln'"
          @click="activeRun ? openFromUrl(`/?mail=${activeRun.uid}`) : (tab = 'einstellungen')"
        >
          <span class="relative flex size-2">
            <span v-if="activeRun" class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span class="relative inline-flex size-2 rounded-full" :class="activeRun ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium text-zinc-800 dark:text-zinc-200">{{ status.config.activeModel }}</span>
            <span class="block text-zinc-500">{{ activeRun ? `schreibt · ${stageLabel(activeRun.stage)}` : "bereit" }}</span>
          </span>
        </button>

        <div :title="`Richtwert: ${status.limit} pro Tag – der Zeitplan hält sich daran, von Hand darfst du mehr`">
          <div class="flex justify-between text-zinc-500">
            <span>Heute veröffentlicht</span>
            <span class="font-medium tabular-nums" :class="status.today >= status.limit ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-800 dark:text-zinc-200'">{{ status.today }} / {{ status.limit }}</span>
          </div>
          <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10">
            <div class="h-full rounded-full transition-all" :class="status.today >= status.limit ? 'bg-amber-500' : 'bg-brand-500'" :style="{ width: `${todayShare}%` }" />
          </div>
        </div>

        <dl class="grid grid-cols-2 gap-2 text-zinc-500">
          <div><dt>Nächster Vorschlag</dt><dd class="mt-0.5 font-medium tabular-nums text-zinc-700 dark:text-zinc-300">{{ shortDate(status.nextSuggestion) }}</dd></div>
          <div v-if="status.config.autoPublish"><dt>Veröffentlichen</dt><dd class="mt-0.5 font-medium tabular-nums text-zinc-700 dark:text-zinc-300">{{ shortDate(status.nextRun) }}</dd></div>
        </dl>

        <button
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-zinc-950/5 disabled:opacity-50 dark:hover:bg-white/5"
          :disabled="push === 'unsupported' || push === 'denied'"
          :title="{ on: 'Chrome-Benachrichtigungen an – klicken zum Abschalten', off: 'Chrome-Benachrichtigungen einschalten', denied: 'Benachrichtigungen sind für diese Seite in Chrome blockiert', unsupported: 'Dieser Browser unterstützt keine Push-Benachrichtigungen' }[push]"
          @click="togglePush"
        >
          <Icon :name="push === 'on' ? 'bell' : 'bell-off'" :class="push === 'on' ? 'text-brand-600 dark:text-brand-300' : 'text-zinc-400'" />
          <span class="flex-1" :class="push === 'on' ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-500'">{{ pushLabel }}</span>
        </button>
      </div>
    </aside>

    <!-- Kopfzeile (Handy/Tablet) -->
    <header class="sticky top-0 z-30 flex items-center gap-3 border-b border-zinc-950/5 bg-white/80 px-4 py-3 backdrop-blur-xl lg:hidden dark:border-white/5 dark:bg-zinc-900/80">
      <img src="/icon.svg" alt="" class="size-8 rounded-lg" />
      <div class="mr-auto min-w-0">
        <p class="text-sm font-semibold tracking-tight">Bühnenpost</p>
        <p class="truncate text-[11px] text-zinc-500">
          <template v-if="activeRun"><span class="text-emerald-600 dark:text-emerald-400">● schreibt</span> · </template>
          {{ status ? `heute ${status.today}/${status.limit}` : "…" }}
        </p>
      </div>
      <button class="btn btn-ghost btn-icon" :disabled="push === 'unsupported' || push === 'denied'" :title="pushLabel" @click="togglePush">
        <Icon :name="push === 'on' ? 'bell' : 'bell-off'" :size="18" />
      </button>
    </header>

    <!-- Inhalt -->
    <main class="pb-24 lg:pb-0 lg:pl-64">
      <div class="mx-auto max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div v-if="error" class="alert alert-error mb-6">
          <Icon name="alert" class="mt-0.5" />
          <span class="min-w-0 flex-1 break-words">{{ error }}</span>
          <button class="-my-0.5 opacity-60 hover:opacity-100" title="Schließen" @click="error = ''"><Icon name="x" /></button>
        </div>

        <template v-if="tab === 'postfach'">
          <PageHeader title="Postfach" description="Musik-Pressemitteilungen prüfen, als Beitrag generieren und nach WordPress bringen.">
            <template #actions>
              <button class="btn" :disabled="suggesting || running" title="Die beste neue Mail als Entwurf vorbereiten" @click="suggestNow">
                <Icon name="sparkles" :class="suggesting && 'animate-pulse'" />{{ suggesting ? "Schreibt …" : "Vorschlag" }}
              </button>
              <button class="btn" :disabled="running" title="Durchlauf ohne Veröffentlichen – zeigt, was passieren würde" @click="run(true)">
                <Icon name="flask" />Testlauf
              </button>
              <button class="btn btn-primary" :disabled="running || !status" title="Durchlauf wie im Zeitplan: veröffentlicht bis zum Limit" @click="run(false)">
                <Icon name="play" :class="running && 'animate-pulse'" />{{ running ? "Läuft …" : "Ausführen" }}
              </button>
            </template>
          </PageHeader>

          <section v-if="runResult" class="card mb-6">
            <div class="card-header">
              <span class="badge" :class="runResult.dryRun ? 'badge-sky' : 'badge-brand'">{{ runResult.dryRun ? "Testlauf" : "Lauf" }}</span>
              <p class="min-w-0 flex-1 text-sm">{{ runResult.message }}</p>
              <button class="btn btn-ghost btn-sm" @click="runResult = null"><Icon name="x" :size="14" />Schließen</button>
            </div>
            <ul v-if="runResult.published.length" class="card-body space-y-1 text-sm">
              <li v-for="p in runResult.published" :key="p.link" class="flex items-center gap-2">
                <Icon name="check" class="text-emerald-600" />
                <a :href="p.link" target="_blank" class="font-medium underline-offset-2 hover:underline">{{ p.title }}</a>
              </li>
            </ul>
            <article v-for="a in runResult.previews" :key="a.slug" class="prose prose-sm prose-zinc max-w-none border-t border-zinc-950/5 p-4 dark:prose-invert dark:border-white/10">
              <h2 class="!mt-0">{{ a.title }}</h2>
              <div v-html="a.content_html" />
            </article>
          </section>

          <InboxView :key="'inbox' + refreshKey" :status="status" :open-uid="openUid" @changed="onChanged" @opened="openUid = null" />
        </template>

        <KalenderView v-else-if="tab === 'kalender'" />

        <template v-else-if="tab === 'verlauf'">
          <PageHeader title="Verlauf" description="Veröffentlichungen, Vorschläge, Abrufe und Fehler – die letzten 100 Ereignisse." />
          <LogList :key="'log' + refreshKey" />
        </template>

        <SettingsView v-else-if="status" :status="status" @changed="loadStatus" />
      </div>
    </main>

    <!-- Navigation unten (Handy/Tablet) -->
    <nav class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-zinc-950/5 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden dark:border-white/5 dark:bg-zinc-900/90">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition"
        :class="tab === t.id ? 'text-brand-700 dark:text-brand-300' : 'text-zinc-500'"
        :aria-current="tab === t.id ? 'page' : undefined"
        @click="tab = t.id"
      >
        <Icon :name="t.icon" :size="20" />
        {{ t.id === "kalender" ? "Kalender" : t.label }}
      </button>
    </nav>
  </div>
</template>
