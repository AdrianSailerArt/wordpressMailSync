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
    <aside class="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-zinc-950 bg-paper lg:flex dark:border-white/30 dark:bg-paper-dark">
      <div class="px-5 pt-7 pb-8">
        <div class="flex items-center gap-3">
          <img src="/icon.svg" alt="" class="size-10" />
          <p class="text-xl leading-none font-black tracking-tight text-zinc-950 uppercase dark:text-white">Bühnen&shy;post</p>
        </div>
        <p class="eyebrow mt-3 truncate text-zinc-600 dark:text-zinc-400">{{ status?.config.site ?? "…" }}</p>
      </div>

      <nav class="flex-1 space-y-1.5 px-3">
        <button
          v-for="(t, i) in tabs"
          :key="t.id"
          class="group relative flex w-full cursor-pointer items-center gap-3 border px-3 py-2.5 text-left transition-all duration-200"
          :class="tab === t.id
            ? '-rotate-1 border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950'
            : 'border-transparent text-zinc-800 hover:border-zinc-950 dark:text-zinc-300 dark:hover:border-white/60'"
          :aria-current="tab === t.id ? 'page' : undefined"
          @click="tab = t.id"
        >
          <span class="w-6 text-lg leading-none font-black tabular-nums" :class="tab === t.id ? 'text-brand-400 dark:text-brand-600' : 'text-brand-600 dark:text-brand-400'">{{ String(i + 1).padStart(2, "0") }}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-bold">{{ t.label }}</span>
            <span class="block truncate text-[11px]" :class="tab === t.id ? 'text-white/60 dark:text-zinc-950/60' : 'text-zinc-500'">{{ t.hint }}</span>
          </span>
          <span v-if="t.id === 'postfach' && activeRun" class="size-2 animate-pulse rounded-full bg-emerald-500" title="Das Modell schreibt gerade" />
        </button>
      </nav>

      <!-- Status -->
      <div v-if="status" class="m-4 space-y-4 border border-zinc-950 bg-white p-3.5 text-xs dark:border-white/40 dark:bg-zinc-900">
        <p class="eyebrow">Status</p>
        <button
          class="flex w-full cursor-pointer items-center gap-2.5 text-left"
          :title="activeRun ? `${stageLabel(activeRun.stage)} – klicken zum Ansehen` : 'Modell wechseln'"
          @click="activeRun ? openFromUrl(`/?mail=${activeRun.uid}`) : (tab = 'einstellungen')"
        >
          <span class="relative flex size-2">
            <span v-if="activeRun" class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span class="relative inline-flex size-2 rounded-full" :class="activeRun ? 'bg-emerald-500' : 'bg-zinc-400'" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate font-semibold text-zinc-950 dark:text-zinc-100">{{ status.config.activeModel }}</span>
            <span class="block text-zinc-500">{{ activeRun ? `schreibt · ${stageLabel(activeRun.stage)}` : "bereit" }}</span>
          </span>
        </button>

        <div :title="`Richtwert: ${status.limit} pro Tag – der Zeitplan hält sich daran, von Hand darfst du mehr`">
          <div class="flex items-baseline justify-between text-zinc-600 dark:text-zinc-400">
            <span>Heute veröffentlicht</span>
            <span class="text-base font-black tabular-nums" :class="status.today >= status.limit ? 'text-brand-600 dark:text-brand-400' : 'text-zinc-950 dark:text-white'">{{ status.today }}<span class="text-xs font-semibold text-zinc-500">/{{ status.limit }}</span></span>
          </div>
          <div class="mt-1.5 h-2 border border-zinc-950 dark:border-white/50">
            <div class="h-full transition-all" :class="status.today >= status.limit ? 'bg-[#ffbf00]' : 'bg-brand-600'" :style="{ width: `${todayShare}%` }" />
          </div>
        </div>

        <dl class="grid grid-cols-2 gap-2 border-t border-zinc-950/15 pt-3 text-zinc-500 dark:border-white/15">
          <div><dt>Nächster Vorschlag</dt><dd class="mt-0.5 font-semibold tabular-nums text-zinc-950 dark:text-zinc-200">{{ shortDate(status.nextSuggestion) }}</dd></div>
          <div v-if="status.config.autoPublish"><dt>Veröffentlichen</dt><dd class="mt-0.5 font-semibold tabular-nums text-zinc-950 dark:text-zinc-200">{{ shortDate(status.nextRun) }}</dd></div>
        </dl>

        <button
          class="-mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer items-center gap-2 border border-transparent px-1 py-1.5 text-left transition hover:border-zinc-950 disabled:opacity-50 dark:hover:border-white/50"
          :disabled="push === 'unsupported' || push === 'denied'"
          :title="{ on: 'Chrome-Benachrichtigungen an – klicken zum Abschalten', off: 'Chrome-Benachrichtigungen einschalten', denied: 'Benachrichtigungen sind für diese Seite in Chrome blockiert', unsupported: 'Dieser Browser unterstützt keine Push-Benachrichtigungen' }[push]"
          @click="togglePush"
        >
          <Icon :name="push === 'on' ? 'bell' : 'bell-off'" :class="push === 'on' ? 'text-brand-600 dark:text-brand-400' : 'text-zinc-400'" />
          <span class="flex-1" :class="push === 'on' ? 'font-semibold text-zinc-950 dark:text-zinc-100' : 'text-zinc-500'">{{ pushLabel }}</span>
        </button>
      </div>
    </aside>

    <!-- Kopfzeile (Handy/Tablet) -->
    <header class="sticky top-0 z-30 flex items-center gap-3 border-b border-zinc-950 bg-paper/95 px-4 py-3 backdrop-blur-md lg:hidden dark:border-white/30 dark:bg-paper-dark/95">
      <img src="/icon.svg" alt="" class="size-8" />
      <div class="mr-auto min-w-0">
        <p class="text-sm leading-tight font-black tracking-tight uppercase">Bühnenpost</p>
        <p class="truncate text-[11px] text-zinc-600 dark:text-zinc-400">
          <template v-if="activeRun"><span class="font-semibold text-emerald-700 dark:text-emerald-400">● schreibt</span> · </template>
          {{ status ? `heute ${status.today}/${status.limit}` : "…" }}
        </p>
      </div>
      <button class="btn btn-ghost btn-icon" :disabled="push === 'unsupported' || push === 'denied'" :title="pushLabel" @click="togglePush">
        <Icon :name="push === 'on' ? 'bell' : 'bell-off'" :size="18" />
      </button>
    </header>

    <!-- Inhalt -->
    <main class="pb-24 lg:pb-0 lg:pl-64">
      <div class="mx-auto max-w-[96rem] px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
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
            <article v-for="a in runResult.previews" :key="a.slug" class="prose prose-sm prose-zinc max-w-none border-t border-zinc-950 p-4 dark:prose-invert dark:border-white/30">
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
    <nav class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-zinc-950 bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden dark:border-white/30 dark:bg-paper-dark/95">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="relative flex cursor-pointer flex-col items-center gap-1 py-2.5 text-[11px] font-bold transition"
        :class="tab === t.id ? 'text-brand-600 dark:text-brand-400' : 'text-zinc-600 dark:text-zinc-400'"
        :aria-current="tab === t.id ? 'page' : undefined"
        @click="tab = t.id"
      >
        <span v-if="tab === t.id" class="absolute inset-x-4 -top-px h-[3px] bg-brand-600 dark:bg-brand-400" />
        <Icon :name="t.icon" :size="20" />
        {{ t.id === "kalender" ? "Kalender" : t.label }}
      </button>
    </nav>
  </div>
</template>
