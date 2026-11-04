<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, formatDate, type Abgleich, type EventState, type KalenderState, type KonzertEvent } from "../api";
import Icon from "./Icon.vue";
import PageHeader from "./PageHeader.vue";

const state = ref<KalenderState | null>(null);
const error = ref("");
const starting = ref(false);
const search = ref("");
const city = ref("");
const country = ref("");
const source = ref("");
const stateFilter = ref<EventState | "">("");
/** Vergleich mit dem Bestand in WordPress */
const abgleich = ref<Abgleich | null>(null);
const abgleichError = ref("");
const checking = ref(false);
const selected = ref<string[]>([]);
const showRemovals = ref(false);
const showWpDuplicates = ref(false);

const last = computed(() => state.value?.last ?? null);
const progress = computed(() => state.value?.progress ?? null);
const sourceName = (id: string) => (id === "manuell" ? "von Hand" : state.value?.sources.find((s) => s.id === id)?.name ?? id);

const checks = computed(() => new Map(abgleich.value?.checks.map((c) => [c.uid, c])));
const checkOf = (uid: string) => checks.value.get(uid);
/** nur neue oder geänderte Termine lassen sich einzeln übertragen */
const selectable = (uid: string) => ["neu", "geändert"].includes(checkOf(uid)?.state ?? "neu");
const counts = computed(() => {
  const c: Record<EventState, number> = { neu: 0, geändert: 0, unverändert: 0, dublette: 0, gesperrt: 0 };
  for (const x of abgleich.value?.checks ?? []) c[x.state]++;
  return c;
});

const STATES: Record<EventState, [string, string]> = {
  neu: ["neu", "badge-green"],
  geändert: ["geändert", "badge-sky"],
  unverändert: ["schon drin", ""],
  dublette: ["Dublette", "badge-amber"],
  gesperrt: ["gesperrt", ""],
};
const FIELD_LABELS: Record<string, string> = {
  date: "Datum", time: "Uhrzeit", title: "Titel", venue: "Location", city: "Ort", country: "Land",
  info: "Infos", url: "Link", status: "Hinweis", artists: "Künstler",
};

const cities = computed(() => [...new Set(last.value?.events.map((e) => e.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de")));
const countries = computed(() => [...new Set(last.value?.events.map((e) => e.country).filter(Boolean))].sort());

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (last.value?.events ?? []).filter((e) =>
    (!city.value || e.city === city.value) &&
    (!country.value || e.country === country.value) &&
    (!source.value || e.source === source.value) &&
    (!stateFilter.value || checkOf(e.uid)?.state === stateFilter.value) &&
    (!q || [e.title, e.venue, e.info, ...e.artists].join(" ").toLowerCase().includes(q)));
});
const visibleSelectable = computed(() => visible.value.filter((e) => selectable(e.uid)).map((e) => e.uid));
const allVisibleSelected = computed(() => visibleSelectable.value.length > 0 && visibleSelectable.value.every((u) => selected.value.includes(u)));

function toggleVisible() {
  const set = new Set(selected.value);
  for (const u of visibleSelectable.value) allVisibleSelected.value ? set.delete(u) : set.add(u);
  selected.value = [...set];
}

/** nach Tag gruppiert, wie auf der Website */
const days = computed(() => {
  const groups: { date: string; events: KonzertEvent[] }[] = [];
  for (const e of [...visible.value].sort((a, b) => `${a.date} ${a.time || "99"}`.localeCompare(`${b.date} ${b.time || "99"}`))) {
    const g = groups.at(-1);
    if (g?.date === e.date) g.events.push(e);
    else groups.push({ date: e.date, events: [e] });
  }
  return groups;
});

const TYPE_LABEL = { seite: "Sprachmodell", vaddi: "fester Parser", z7: "fester Parser", regioactive: "regioactive.de", ticketmaster: "API" } as const;

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

const elapsed = computed(() => {
  if (!progress.value) return "";
  const s = Math.round((Date.now() - Date.parse(progress.value.startedAt)) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`;
});

async function load() {
  try {
    state.value = await api.kalender();
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function loadAbgleich() {
  if (!last.value) return;
  checking.value = true;
  try {
    abgleich.value = await api.kalenderAbgleich();
    abgleichError.value = "";
    // was inzwischen drin oder Dublette ist, nicht mehr ausgewählt lassen
    selected.value = selected.value.filter(selectable);
  } catch (e) {
    abgleich.value = null;
    abgleichError.value = (e as Error).message;
  } finally {
    checking.value = false;
  }
}

// nach jedem Abruf oder Übertragen neu mit WordPress vergleichen
watch(
  () => (state.value && !state.value.busy && last.value ? `${last.value.at}|${last.value.transferredAt}|${last.value.transferredUids?.length}` : ""),
  (key) => key && loadAbgleich(),
);

async function start(action: () => Promise<unknown>) {
  starting.value = true;
  try {
    await action();
    await poll();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    starting.value = false;
  }
}

const dryRun = (only: string[] = []) => start(() => api.kalenderRun(true, only));
const runAndTransfer = () => start(() => api.kalenderRun(false));
const transferAll = () => start(() => api.kalenderTransfer());
const cancel = () => start(() => api.kalenderCancel());
const transferSelected = () => start(async () => {
  await api.kalenderTransfer({ uids: selected.value });
  selected.value = [];
});
const transferSource = (id: string) => start(() => api.kalenderTransfer({ sources: [id] }));
/** Quelle hat abrufbare Termine aus dem letzten Abruf */
const canTransfer = (id: string) => {
  const r = last.value?.sources.find((s) => s.id === id);
  return !!r && !r.error && !r.skipped && r.found > 0;
};

// während eines Abrufs alle 3 Sekunden nachsehen, sonst jede Minute (Zeitplan)
let timer: ReturnType<typeof setTimeout> | undefined;
async function poll() {
  clearTimeout(timer);
  await load();
  timer = setTimeout(poll, state.value?.busy ? 3000 : 60_000);
}
onMounted(poll);
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div v-if="!state" class="space-y-4">
    <div v-if="error" class="alert alert-error"><Icon name="alert" class="mt-0.5" />{{ error }}</div>
    <template v-else><div class="skeleton h-8 w-64" /><div class="skeleton h-32 w-full rounded-xl" /></template>
  </div>

  <div v-else>
    <PageHeader title="Konzertkalender">
      <template #description>
        <template v-if="last">
          {{ last.events.length }} Termine · abgerufen {{ formatDate(last.at) }} ·
          <span v-if="!last.dryRun" class="text-emerald-700 dark:text-emerald-400">übertragen {{ formatDate(last.transferredAt ?? last.at) }}</span>
          <span v-else-if="last.transferredUids?.length || last.transferredSources?.length" class="text-amber-700 dark:text-amber-400">
            teilweise übertragen<template v-if="last.transferredSources?.length">: {{ last.transferredSources.map(sourceName).join(", ") }}</template><template v-if="last.transferredUids?.length"> · {{ last.transferredUids.length }} einzelne Termine</template>
          </span>
          <span v-else class="text-amber-700 dark:text-amber-400">Probelauf, noch nicht übertragen</span>
        </template>
        <template v-else>Termine von Clubs, Veranstaltern und Ticketmaster – noch nicht abgerufen.</template>
      </template>
      <template #actions>
        <button class="btn" :disabled="state.busy || starting" title="Alle Quellen lesen, nichts an WordPress schicken" @click="dryRun()">
          <Icon name="download" />Probelauf
        </button>
        <button
          v-if="last"
          class="btn"
          :disabled="state.busy || starting || !abgleich"
          title="Alle abgerufenen Termine an WordPress schicken (ohne Dubletten), ohne die Seiten erneut zu lesen. Termine, die eine Quelle nicht mehr liefert, werden entfernt."
          @click="transferAll"
        ><Icon name="upload" />Alle übertragen</button>
        <button class="btn btn-primary" :disabled="state.busy || starting" @click="runAndTransfer">
          <Icon name="refresh" :class="state.busy && 'animate-spin'" />{{ state.busy ? "Läuft …" : "Abrufen & übertragen" }}
        </button>
      </template>
    </PageHeader>

    <div class="mb-6 space-y-3">
      <div v-if="error" class="alert alert-error"><Icon name="alert" class="mt-0.5" /><span class="break-words">{{ error }}</span></div>
      <div class="flex flex-wrap gap-2 text-xs">
        <span class="badge"><Icon name="clock" :size="12" />
          <template v-if="state.config.auto">automatisch · nächster Abruf {{ formatDate(state.nextRun) }}</template>
          <template v-else>nur von Hand · täglich mit KALENDER_AUTO=true</template>
        </span>
        <span class="badge"><Icon name="globe" :size="12" />neue Termine {{ state.config.postStatus === "draft" ? "als Entwurf" : "sofort sichtbar" }}</span>
      </div>
      <div v-if="!state.config.ticketmaster" class="alert alert-warn text-xs">
        <Icon name="alert" :size="14" class="mt-px" />
        <span>
          Ticketmaster ist aus: kostenlosen Schlüssel auf
          <a href="https://developer.ticketmaster.com" target="_blank" class="font-medium underline underline-offset-2">developer.ticketmaster.com</a>
          holen und als <code class="font-mono">TICKETMASTER_API_KEY</code> in die <code class="font-mono">.env</code> eintragen.
        </span>
      </div>
    </div>

    <!-- Fortschritt -->
    <section v-if="progress" class="card mb-6 overflow-hidden">
      <div class="card-header">
        <span class="relative flex size-2.5">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span class="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
        </span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">
          <template v-if="progress.cancelling">Wird abgebrochen …</template>
          <template v-else>{{ progress.task === "abrufen" ? "Liest" : "Überträgt" }} {{ progress.current || "…" }}</template>
        </span>
        <span class="text-xs tabular-nums text-zinc-500">{{ progress.done }} / {{ progress.total }} · {{ elapsed }}</span>
        <button
          class="btn btn-sm btn-danger"
          :disabled="progress.cancelling || starting"
          title="Stoppt auch die laufende Anfrage an das Sprachmodell. Fertige Quellen bleiben, die übrigen behalten ihr voriges Ergebnis; übertragen wird nichts mehr."
          @click="cancel"
        ><Icon name="stop" :size="12" />Abbrechen</button>
      </div>
      <div class="h-1 bg-zinc-950/5 dark:bg-white/5">
        <div class="h-full bg-brand-500 transition-all duration-500" :style="{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }" />
      </div>
      <div class="card-body space-y-2">
        <p v-if="progress.task === 'abrufen' && progress.reading" class="flex items-center gap-1.5 text-xs text-zinc-500">
          <Icon name="cpu" :size="13" />Das Sprachmodell liest {{ progress.reading }} – neue oder geänderte Abschnitte dauern je etwa eine Minute, unveränderte kommen aus dem Zwischenspeicher.
        </p>
        <ul v-if="progress.lines.length" class="space-y-0.5 font-mono text-xs text-zinc-500">
          <li v-for="(l, i) in progress.lines" :key="i">{{ l }}</li>
        </ul>
      </div>
    </section>

    <!-- Abgleich mit WordPress -->
    <section v-if="last && !progress" class="card mb-6">
      <div class="card-header">
        <Icon name="layers" class="text-zinc-400" />
        <h2 class="text-sm font-semibold">Abgleich mit WordPress</h2>
        <span v-if="abgleich" class="text-xs text-zinc-500">{{ abgleich.total }} Termine dort · geprüft {{ formatDate(abgleich.at) }}</span>
        <button class="btn btn-ghost btn-sm ml-auto" :disabled="checking" @click="loadAbgleich">
          <Icon name="refresh" :size="13" :class="checking && 'animate-spin'" />{{ checking ? "Prüft …" : "Neu prüfen" }}
        </button>
      </div>
      <div class="card-body">
        <div v-if="abgleichError" class="alert alert-error text-xs"><Icon name="alert" :size="14" class="mt-px" />{{ abgleichError }}</div>
        <template v-else-if="abgleich">
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="s in (['neu', 'geändert', 'unverändert', 'dublette', 'gesperrt'] as const)"
              v-show="counts[s]"
              :key="s"
              class="badge !px-2 !py-1 !text-xs transition"
              :class="[STATES[s][1], stateFilter === s ? '!ring-2 !ring-current' : 'hover:opacity-80']"
              :title="s === 'dublette' ? 'Derselbe Abend steht schon aus einer anderen Quelle oder von Hand in WordPress – wird nicht nochmal angelegt' : 'Nur diese zeigen'"
              @click="stateFilter = stateFilter === s ? '' : s"
            ><span class="font-semibold tabular-nums">{{ counts[s] }}</span> {{ STATES[s][0] }}</button>
            <button v-if="abgleich.removals.length" class="badge badge-rose !px-2 !py-1 !text-xs" @click="showRemovals = !showRemovals">
              <span class="font-semibold tabular-nums">{{ abgleich.removals.length }}</span> würden entfernt
            </button>
            <button v-if="abgleich.wpDuplicates.length" class="badge badge-amber !px-2 !py-1 !text-xs" @click="showWpDuplicates = !showWpDuplicates">
              <span class="font-semibold tabular-nums">{{ abgleich.wpDuplicates.length }}×</span> doppelt in WordPress
            </button>
            <span v-if="!abgleich.removals.length && !abgleich.wpDuplicates.length && !counts.dublette" class="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
              <Icon name="check" :size="13" />keine Dubletten
            </span>
            <button v-if="stateFilter" class="btn btn-ghost btn-sm" @click="stateFilter = ''"><Icon name="x" :size="12" />Filter aufheben</button>
          </div>

          <div v-if="showRemovals && abgleich.removals.length" class="mt-4 rounded-lg bg-rose-50/60 p-3 text-xs ring-1 ring-rose-600/10 dark:bg-rose-500/5 dark:ring-rose-400/15">
            <p class="text-zinc-600 dark:text-zinc-400">Diese Termine liefert ihre Quelle nicht mehr – „Alle übertragen“ entfernt sie (einzelnes Übertragen nicht). Behalten: in WordPress „Nicht automatisch überschreiben“ anhaken.</p>
            <ul class="mt-2 space-y-1">
              <li v-for="r in abgleich.removals" :key="r.id">
                <span class="tabular-nums text-zinc-500">{{ r.date }}</span> · <a :href="r.edit_link" target="_blank" class="font-medium underline-offset-2 hover:underline">{{ r.title }}</a>
                <span class="text-zinc-400"> · {{ sourceName(r.source) }}</span>
              </li>
            </ul>
          </div>

          <div v-if="showWpDuplicates && abgleich.wpDuplicates.length" class="mt-4 rounded-lg bg-amber-50/60 p-3 text-xs ring-1 ring-amber-600/10 dark:bg-amber-500/5 dark:ring-amber-400/15">
            <p class="text-zinc-600 dark:text-zinc-400">Derselbe Abend steht in WordPress mehrfach – einen davon dort löschen oder auf Entwurf setzen.</p>
            <ul class="mt-2 space-y-1">
              <li v-for="[a, b] in abgleich.wpDuplicates" :key="a.id + '-' + b.id">
                <span class="tabular-nums text-zinc-500">{{ a.date }}</span> ·
                <a :href="a.edit_link" target="_blank" class="font-medium underline-offset-2 hover:underline">{{ a.title }}</a> <span class="text-zinc-400">({{ sourceName(a.source) }}, {{ a.post_status }})</span>
                und
                <a :href="b.edit_link" target="_blank" class="font-medium underline-offset-2 hover:underline">{{ b.title }}</a> <span class="text-zinc-400">({{ sourceName(b.source) }}, {{ b.post_status }})</span>
              </li>
            </ul>
          </div>
        </template>
        <div v-else class="flex gap-2"><div v-for="n in 3" :key="n" class="skeleton h-6 w-24" /></div>
      </div>
    </section>

    <div class="grid items-start gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
      <!-- Quellen -->
      <aside class="card min-w-0 overflow-hidden xl:sticky xl:top-6">
        <div class="card-header">
          <h2 class="text-sm font-semibold">Quellen</h2>
          <span class="text-xs text-zinc-500">{{ state.sources.length }}</span>
          <button v-if="source" class="btn btn-ghost btn-sm ml-auto" @click="source = ''"><Icon name="x" :size="12" />alle zeigen</button>
        </div>
        <ul class="max-h-96 divide-y divide-zinc-950/5 overflow-y-auto xl:max-h-[calc(100dvh-12rem)] dark:divide-white/5">
          <li v-for="s in state.sources" :key="s.id">
            <div class="relative px-4 py-3 transition-colors" :class="source === s.id ? 'bg-brand-50/70 dark:bg-brand-500/10' : ''">
              <span v-if="source === s.id" class="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand-600 dark:bg-brand-400" />
              <div class="flex items-center gap-2">
                <button class="min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-brand-700 dark:hover:text-brand-300" title="Nur Termine dieser Quelle zeigen" @click="source = source === s.id ? '' : s.id">
                  {{ s.name }}
                </button>
                <a :href="s.url" target="_blank" class="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Seite öffnen"><Icon name="external" :size="13" /></a>
              </div>
              <template v-for="r in [last?.sources.find((x) => x.id === s.id)]" :key="s.id + 'r'">
                <p v-if="r?.error" class="mt-1 line-clamp-2 break-words text-xs text-rose-600 dark:text-rose-400" :title="r.error">{{ r.error }}</p>
                <p v-else-if="r?.skipped" class="mt-1 text-xs text-amber-700 dark:text-amber-400">{{ r.skipped }}</p>
                <template v-else-if="r">
                  <p class="mt-1 flex flex-wrap gap-x-2 text-xs tabular-nums text-zinc-500">
                    <span><span class="font-medium text-zinc-700 dark:text-zinc-300">{{ r.found }}</span> Termine</span>
                    <span v-if="r.sent !== r.found">{{ r.found - r.sent }} doppelt</span>
                    <span v-if="r.wp" class="text-emerald-700 dark:text-emerald-400">{{ r.wp.created }} neu · {{ r.wp.updated }} aktualisiert<template v-if="r.wp.deleted"> · {{ r.wp.deleted }} entfernt</template></span>
                  </p>
                  <p v-if="r.sendError" class="mt-1 break-words text-xs text-rose-600 dark:text-rose-400">Übertragen: {{ r.sendError }}</p>
                </template>
                <p v-else class="mt-1 text-xs text-zinc-400">noch nicht abgerufen</p>
              </template>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <span class="badge mr-auto">{{ TYPE_LABEL[s.typ] }}</span>
                <button
                  class="btn btn-sm"
                  :disabled="state.busy || starting"
                  title="Nur diese Location neu abrufen – nichts an WordPress schicken, die anderen Quellen bleiben wie sie sind"
                  @click="dryRun([s.id])"
                ><Icon name="download" :size="12" />abrufen</button>
                <button
                  v-if="canTransfer(s.id)"
                  class="btn btn-sm"
                  :disabled="state.busy || starting || !abgleich"
                  title="Nur die Termine dieser Location an WordPress schicken (ohne Dubletten). Ihre Termine, die sie nicht mehr liefert, werden entfernt – andere Quellen bleiben unberührt."
                  @click="transferSource(s.id)"
                ><Icon name="upload" :size="12" />übertragen</button>
              </div>
            </div>
          </li>
        </ul>
      </aside>

      <!-- Termine -->
      <section class="min-w-0">
        <div class="card mb-4 flex flex-wrap items-center gap-2 p-2">
          <div class="relative min-w-48 flex-1">
            <Icon name="search" :size="15" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-zinc-400" />
            <input v-model="search" class="field !pl-9 !shadow-none !ring-0" placeholder="Künstler, Location, Infos …" />
          </div>
          <select v-model="city" class="field w-auto">
            <option value="">Alle Orte</option>
            <option v-for="c in cities" :key="c">{{ c }}</option>
          </select>
          <select v-model="country" class="field w-auto">
            <option value="">Alle Länder</option>
            <option v-for="c in countries" :key="c">{{ c }}</option>
          </select>
          <span class="px-2 text-xs tabular-nums text-zinc-500">{{ visible.length }} Termine</span>
        </div>

        <!-- Auswahl -->
        <div v-if="abgleich && last" class="sticky top-16 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-xl px-3 py-2 text-xs transition lg:top-2"
          :class="selected.length ? 'bg-brand-600 text-white shadow-lg shadow-brand-600/20 dark:bg-brand-500' : 'bg-white/90 text-zinc-600 ring-1 ring-zinc-950/5 backdrop-blur dark:bg-zinc-900/90 dark:text-zinc-400 dark:ring-white/10'">
          <label class="flex items-center gap-2" :class="!visibleSelectable.length && 'opacity-50'">
            <input type="checkbox" :checked="allVisibleSelected" :disabled="!visibleSelectable.length" @change="toggleVisible" />
            Neue und geänderte in der Ansicht auswählen ({{ visibleSelectable.length }})
          </label>
          <template v-if="selected.length">
            <span class="ml-auto font-medium">{{ selected.length }} ausgewählt</span>
            <button class="rounded-md px-2 py-1 font-medium hover:bg-white/15" @click="selected = []">Aufheben</button>
            <button class="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1 font-semibold text-brand-700 shadow-sm hover:bg-brand-50" :disabled="state.busy || starting" @click="transferSelected">
              <Icon name="upload" :size="12" />Ausgewählte übertragen
            </button>
          </template>
        </div>

        <div v-if="!last" class="empty">
          <Icon name="calendar" :size="32" class="text-zinc-300 dark:text-zinc-600" />
          <p class="font-medium text-zinc-700 dark:text-zinc-300">Noch keine Termine</p>
          <p>„Probelauf“ liest alle Quellen, ohne etwas zu übertragen.</p>
        </div>
        <div v-else-if="!days.length" class="empty"><p>Keine Termine für diese Auswahl.</p></div>

        <div class="space-y-4">
          <section v-for="d in days" :key="d.date" class="card overflow-hidden">
            <h3 class="flex items-baseline gap-2 border-b border-zinc-950/5 bg-zinc-950/[0.02] px-4 py-2 dark:border-white/10 dark:bg-white/[0.02]">
              <span class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ dayLabel(d.date) }}</span>
              <span class="text-xs text-zinc-500">{{ d.events.length }} {{ d.events.length === 1 ? "Termin" : "Termine" }}</span>
            </h3>
            <ul class="divide-y divide-zinc-950/5 dark:divide-white/5">
              <li v-for="e in d.events" :key="e.uid" class="flex gap-3 px-4 py-3 transition-colors" :class="selected.includes(e.uid) && 'bg-brand-50/50 dark:bg-brand-500/5'">
                <input
                  v-model="selected"
                  type="checkbox"
                  class="mt-1"
                  :value="e.uid"
                  :disabled="!abgleich || !selectable(e.uid)"
                  :title="selectable(e.uid) ? 'Zum Übertragen auswählen' : 'Steht schon in WordPress'"
                />
                <div class="w-12 shrink-0 pt-px text-sm tabular-nums text-zinc-500">{{ e.time || "–" }}</div>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-start gap-x-2 gap-y-1">
                    <a v-if="e.url" :href="e.url" target="_blank" class="min-w-0 font-semibold text-zinc-900 underline-offset-2 hover:text-brand-700 hover:underline dark:text-zinc-100 dark:hover:text-brand-300">{{ e.artists.join(", ") || e.title }}</a>
                    <span v-else class="min-w-0 font-semibold">{{ e.artists.join(", ") || e.title }}</span>
                    <span v-if="e.status" class="badge badge-amber">{{ e.status }}</span>
                  </div>
                  <p class="mt-0.5 flex items-center gap-1 text-sm text-zinc-600 dark:text-zinc-400">
                    <Icon name="map-pin" :size="13" class="text-zinc-400" />
                    {{ [e.venue, e.city].filter(Boolean).join(", ") }}<template v-if="e.country && e.country !== 'DE'"> ({{ e.country }})</template>
                  </p>
                  <p v-if="e.info" class="mt-0.5 text-xs text-zinc-500">{{ e.info }}</p>
                  <p v-if="checkOf(e.uid)?.state === 'dublette'" class="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    Steht schon in WordPress:
                    <a :href="checkOf(e.uid)!.existing!.edit_link" target="_blank" class="font-medium underline underline-offset-2">{{ checkOf(e.uid)!.existing!.title }}</a>
                    ({{ sourceName(checkOf(e.uid)!.existing!.source) }}) – wird nicht nochmal angelegt
                  </p>
                </div>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <template v-for="c in [checkOf(e.uid)]" :key="e.uid + 'c'">
                    <a
                      v-if="c"
                      :href="c.existing?.edit_link"
                      target="_blank"
                      class="badge"
                      :class="[STATES[c.state][1], !c.existing && 'pointer-events-none']"
                      :title="c.changes?.length ? `Ändert: ${c.changes.map((f) => FIELD_LABELS[f] ?? f).join(', ')}` : c.existing ? 'In WordPress öffnen' : ''"
                    >{{ STATES[c.state][0] }}</a>
                  </template>
                  <span class="badge">{{ sourceName(e.source) }}</span>
                </div>
              </li>
            </ul>
          </section>
        </div>
      </section>
    </div>
  </div>
</template>
