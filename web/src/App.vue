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
import SetupWizard from "./components/SetupWizard.vue";

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
/** Einrichtung: öffnet sich von selbst, solange WordPress oder ein Postfach fehlt */
const showSetup = ref<number | false>(false);
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

const pushLabel = computed(() => ({
  on: "Benachrichtigungen an",
  off: "Benachrichtigungen aus",
  denied: "Blockiert – so geht's wieder",
  unsupported: "Nicht unterstützt",
})[push.value]);

/** Anleitung, wenn der Browser Benachrichtigungen für diese Seite blockiert */
const pushHelp = ref(false);
const host = location.host;

async function refreshPush() {
  push.value = await pushState();
  if (push.value !== "denied") pushHelp.value = false;
}

async function togglePush() {
  if (push.value === "denied") {
    pushHelp.value = true;
    return;
  }
  try {
    push.value = push.value === "on" ? await disablePush() : await enablePush();
    if (push.value === "denied") pushHelp.value = true;
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
    runResult.value = { skipped: 0, previews: [], message: r.message };
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

/** Testlauf: Entwürfe zeigen – veröffentlicht nie */
async function run() {
  running.value = true;
  runResult.value = null;
  try {
    runResult.value = await api.run();
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
  api.setup().then((s) => (showSetup.value = s.needed ? 0 : false)).catch(() => {});
  connectLive();
  refreshPush();
  // Wer die Erlaubnis in den Website-Einstellungen ändert, soll das ohne Neuladen sehen
  window.addEventListener("focus", refreshPush);
  navigator.permissions?.query({ name: "notifications" }).then((p) => (p.onchange = refreshPush)).catch(() => {});
  onOpenRequest(openFromUrl);
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("popstate", onHashChange);
  if (openUid.value) history.replaceState(null, "", "/#postfach");
  timer = setInterval(loadStatus, 60_000);
});
onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener("focus", refreshPush);
  window.removeEventListener("hashchange", onHashChange);
  window.removeEventListener("popstate", onHashChange);
});
</script>

<template>
  <div class="min-h-dvh">
    <SetupWizard v-if="showSetup !== false" :start="showSetup" @close="showSetup = false" @changed="loadStatus" />
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
          v-for="t in tabs"
          :key="t.id"
          class="group relative flex w-full cursor-pointer items-center gap-3 border px-3 py-2.5 text-left transition-all duration-200"
          :class="tab === t.id
            ? '-rotate-1 border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950'
            : 'border-transparent text-zinc-800 hover:border-zinc-950 dark:text-zinc-300 dark:hover:border-white/60'"
          :aria-current="tab === t.id ? 'page' : undefined"
          @click="tab = t.id"
        >
          <Icon :name="t.icon" :size="20" class="shrink-0" :class="tab === t.id ? 'text-brand-400 dark:text-brand-600' : 'text-brand-600 dark:text-brand-400'" />
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

        <div class="flex items-baseline justify-between text-zinc-600 dark:text-zinc-400" title="Veröffentlicht wird nur, was du freigibst">
          <span>Heute veröffentlicht</span>
          <span class="text-base font-black tabular-nums text-zinc-950 dark:text-white">{{ status.today }}</span>
        </div>

        <dl class="grid grid-cols-2 gap-2 border-t border-zinc-950/15 pt-3 text-zinc-500 dark:border-white/15">
          <div><dt>Nächster Vorschlag</dt><dd class="mt-0.5 font-semibold tabular-nums text-zinc-950 dark:text-zinc-200">{{ shortDate(status.nextSuggestion) }}</dd></div>
          <div><dt>Veröffentlichen</dt><dd class="mt-0.5 font-semibold text-zinc-950 dark:text-zinc-200">nur mit Freigabe</dd></div>
        </dl>

        <button
          class="-mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer items-center gap-2 border border-transparent px-1 py-1.5 text-left transition hover:border-zinc-950 disabled:opacity-50 dark:hover:border-white/50"
          :disabled="push === 'unsupported'"
          :title="{ on: 'Benachrichtigungen an – klicken zum Abschalten', off: 'Benachrichtigungen einschalten', denied: 'Der Browser blockiert Benachrichtigungen für diese Seite – klicken für die Anleitung', unsupported: 'Dieser Browser unterstützt keine Push-Benachrichtigungen' }[push]"
          @click="togglePush"
        >
          <Icon :name="push === 'on' ? 'bell' : 'bell-off'" :class="push === 'on' ? 'text-brand-600 dark:text-brand-400' : 'text-zinc-400'" />
          <span class="flex-1" :class="push === 'on' ? 'font-semibold text-zinc-950 dark:text-zinc-100' : push === 'denied' ? 'text-brand-700 underline underline-offset-2 dark:text-brand-300' : 'text-zinc-500'">{{ pushLabel }}</span>
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
          {{ status ? `heute ${status.today} veröffentlicht` : "…" }}
        </p>
      </div>
      <button class="btn btn-ghost btn-icon" :disabled="push === 'unsupported'" :title="pushLabel" @click="togglePush">
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

        <div v-if="pushHelp" class="alert alert-warn mb-6">
          <Icon name="bell-off" class="mt-0.5" />
          <div class="min-w-0 flex-1 space-y-2">
            <p class="font-semibold">Der Browser blockiert Benachrichtigungen für {{ host }}</p>
            <ol class="list-decimal space-y-1 pl-5">
              <li>Links in der Adresszeile auf das Symbol vor <code class="font-mono text-xs">{{ host }}</code> klicken → <b>Website-Einstellungen</b>.</li>
              <li><b>Benachrichtigungen</b> auf <b>Zulassen</b> stellen und hierher zurückkommen – der Schalter wird dann wieder aktiv.</li>
              <li>Kommt danach trotzdem nichts an: in macOS unter <b>Systemeinstellungen → Mitteilungen → Google Chrome</b> Mitteilungen erlauben und prüfen, ob ein Fokus-Modus aktiv ist.</li>
            </ol>
            <p class="text-xs text-zinc-600 dark:text-zinc-400">Die Erlaubnis gilt pro Adresse samt Port. In eingebetteten Vorschau-Browsern lässt sie sich oft gar nicht erteilen – dann die Seite in Chrome öffnen.</p>
          </div>
          <button class="-my-0.5 cursor-pointer opacity-60 hover:opacity-100" title="Schließen" @click="pushHelp = false"><Icon name="x" /></button>
        </div>

        <template v-if="tab === 'postfach'">
          <PageHeader title="Postfach" description="Musik-Pressemitteilungen prüfen, als Beitrag generieren und nach WordPress bringen.">
            <template #actions>
              <button class="btn" :disabled="suggesting || running" title="Die beste neue Mail als Entwurf vorbereiten" @click="suggestNow">
                <Icon name="sparkles" :class="suggesting && 'animate-pulse'" />{{ suggesting ? "Schreibt …" : "Vorschlag" }}
              </button>
              <button class="btn" :disabled="running" title="Entwürfe für die nächsten Mails zeigen – veröffentlicht nichts" @click="run()">
                <Icon name="flask" />Testlauf
              </button>
            </template>
          </PageHeader>

          <section v-if="runResult" class="card mb-6">
            <div class="card-header">
              <span class="badge badge-sky">Testlauf</span>
              <p class="min-w-0 flex-1 text-sm">{{ runResult.message }}</p>
              <button class="btn btn-ghost btn-sm" @click="runResult = null"><Icon name="x" :size="14" />Schließen</button>
            </div>
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

        <SettingsView v-else-if="status" :status="status" @changed="loadStatus" @setup="(step) => (showSetup = step ?? 0)" />
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
