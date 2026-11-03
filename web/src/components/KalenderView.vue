<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, formatDate, type Abgleich, type EventState, type KalenderState, type KonzertEvent } from "../api";

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
  neu: ["neu", "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"],
  geändert: ["geändert", "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300"],
  unverändert: ["schon drin", "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"],
  dublette: ["Dublette", "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"],
  gesperrt: ["gesperrt", "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"],
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
  await api.kalenderTransfer(selected.value);
  selected.value = [];
});

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
  <div v-if="!state" class="text-sm text-zinc-500">
    <p v-if="error" class="rounded-md bg-rose-50 px-3 py-2 text-rose-700 dark:bg-rose-950 dark:text-rose-300">{{ error }}</p>
    <p v-else>Wird geladen …</p>
  </div>

  <div v-else>
    <p v-if="error" class="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">{{ error }}</p>

    <div class="mb-6 flex flex-wrap items-start gap-4">
      <div class="mr-auto min-w-0 text-sm">
        <h2 class="text-base font-semibold">Konzertkalender</h2>
        <p v-if="last" class="mt-0.5 text-xs text-zinc-500">
          {{ last.events.length }} Termine · abgerufen {{ formatDate(last.at) }} ·
          <span v-if="!last.dryRun">übertragen {{ formatDate(last.transferredAt ?? last.at) }}</span>
          <span v-else-if="last.transferredUids?.length" class="text-amber-600 dark:text-amber-400">{{ last.transferredUids.length }} einzeln übertragen</span>
          <span v-else class="text-amber-600 dark:text-amber-400">Probelauf, noch nicht übertragen</span>
        </p>
        <p v-else class="mt-0.5 text-xs text-zinc-500">Noch nicht abgerufen.</p>
        <p class="mt-0.5 text-xs text-zinc-500">
          <template v-if="state.config.auto">Automatisch: nächster Abruf {{ formatDate(state.nextRun) }}</template>
          <template v-else>Nur von Hand – täglich mit <code class="font-mono">KALENDER_AUTO=true</code></template>
          · neue Termine in WordPress: {{ state.config.postStatus === "draft" ? "als Entwurf" : "sofort sichtbar" }}
        </p>
      </div>
      <div class="flex flex-wrap gap-1">
        <button class="btn" :disabled="state.busy || starting" title="Alle Quellen lesen, nichts an WordPress schicken" @click="dryRun()">Probelauf</button>
        <button
          v-if="last"
          class="btn"
          :disabled="state.busy || starting || !abgleich"
          title="Alle abgerufenen Termine an WordPress schicken (ohne Dubletten), ohne die Seiten erneut zu lesen. Termine, die eine Quelle nicht mehr liefert, werden entfernt."
          @click="transferAll"
        >Alle übertragen</button>
        <button class="btn btn-primary" :disabled="state.busy || starting" @click="runAndTransfer">
          {{ state.busy ? "Läuft …" : "Abrufen & übertragen" }}
        </button>
      </div>
    </div>

    <p v-if="!state.config.ticketmaster" class="mb-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
      Ticketmaster ist aus: kostenlosen Schlüssel auf
      <a href="https://developer.ticketmaster.com" target="_blank" class="underline underline-offset-2">developer.ticketmaster.com</a>
      holen und als <code class="font-mono">TICKETMASTER_API_KEY</code> in die <code class="font-mono">.env</code> eintragen.
    </p>

    <section v-if="progress" class="mb-6 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div class="flex items-center gap-2">
        <span class="size-1.5 animate-pulse rounded-full bg-emerald-500" />
        <span class="font-medium">
          <template v-if="progress.cancelling">Wird abgebrochen …</template>
          <template v-else>{{ progress.task === "abrufen" ? "Liest" : "Überträgt" }} {{ progress.current || "…" }}</template>
        </span>
        <span class="ml-auto text-xs tabular-nums text-zinc-500">{{ progress.done }} / {{ progress.total }} · {{ elapsed }}</span>
        <button
          class="btn btn-danger -my-1 -mr-2 h-7 text-xs"
          :disabled="progress.cancelling || starting"
          title="Stoppt auch die laufende Anfrage an das Sprachmodell. Fertige Quellen bleiben, die übrigen behalten ihr voriges Ergebnis; übertragen wird nichts mehr."
          @click="cancel"
        >Abbrechen</button>
      </div>
      <div class="mt-2 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
        <div class="h-full bg-zinc-900 transition-all dark:bg-white" :style="{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }" />
      </div>
      <p v-if="progress.task === 'abrufen' && state.sources.find((s) => s.name === progress?.current)?.typ === 'seite'" class="mt-2 text-xs text-zinc-500">
        Das Sprachmodell liest die Seite – das dauert etwa ein bis zwei Minuten.
      </p>
      <ul v-if="progress.lines.length" class="mt-2 space-y-0.5 font-mono text-xs text-zinc-500">
        <li v-for="(l, i) in progress.lines" :key="i">{{ l }}</li>
      </ul>
    </section>

    <!-- Abgleich mit WordPress -->
    <section v-if="last && !progress" class="mb-6 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 class="eyebrow">Abgleich mit WordPress</h3>
        <template v-if="abgleich">
          <span class="text-xs text-zinc-500">{{ abgleich.total }} Termine dort · geprüft {{ formatDate(abgleich.at) }}</span>
        </template>
        <button class="btn -my-1 ml-auto h-7 text-xs" :disabled="checking" @click="loadAbgleich">{{ checking ? "Prüft …" : "Neu prüfen" }}</button>
      </div>
      <p v-if="abgleichError" class="mt-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-300">{{ abgleichError }}</p>
      <template v-else-if="abgleich">
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            v-for="s in (['neu', 'geändert', 'unverändert', 'dublette', 'gesperrt'] as const)"
            :key="s"
            v-show="counts[s]"
            class="rounded px-2 py-0.5 text-xs transition-shadow"
            :class="[STATES[s][1], stateFilter === s && 'ring-1 ring-current']"
            :title="s === 'dublette' ? 'Derselbe Abend steht schon aus einer anderen Quelle oder von Hand in WordPress – wird nicht nochmal angelegt' : 'Nur diese zeigen'"
            @click="stateFilter = stateFilter === s ? '' : s"
          >{{ counts[s] }} {{ STATES[s][0] }}</button>
          <button v-if="abgleich.removals.length" class="rounded bg-rose-50 px-2 py-0.5 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-300" @click="showRemovals = !showRemovals">
            {{ abgleich.removals.length }} würden entfernt
          </button>
          <button v-if="abgleich.wpDuplicates.length" class="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300" @click="showWpDuplicates = !showWpDuplicates">
            {{ abgleich.wpDuplicates.length }}× doppelt in WordPress
          </button>
          <span v-if="!abgleich.removals.length && !abgleich.wpDuplicates.length && !counts.dublette" class="self-center text-xs text-zinc-500">keine Dubletten</span>
        </div>

        <div v-if="showRemovals && abgleich.removals.length" class="mt-3 text-xs">
          <p class="text-zinc-500">Diese Termine liefert ihre Quelle nicht mehr – „Alle übertragen“ entfernt sie (einzelnes Übertragen nicht). Behalten: in WordPress „Nicht automatisch überschreiben“ anhaken.</p>
          <ul class="mt-1 space-y-0.5">
            <li v-for="r in abgleich.removals" :key="r.id">
              <span class="tabular-nums text-zinc-500">{{ r.date }}</span> · <a :href="r.edit_link" target="_blank" class="underline-offset-2 hover:underline">{{ r.title }}</a>
              <span class="text-zinc-400"> · {{ sourceName(r.source) }}</span>
            </li>
          </ul>
        </div>

        <div v-if="showWpDuplicates && abgleich.wpDuplicates.length" class="mt-3 text-xs">
          <p class="text-zinc-500">Derselbe Abend steht in WordPress mehrfach – einen davon dort löschen oder auf Entwurf setzen.</p>
          <ul class="mt-1 space-y-1">
            <li v-for="[a, b] in abgleich.wpDuplicates" :key="a.id + '-' + b.id">
              <span class="tabular-nums text-zinc-500">{{ a.date }}</span> ·
              <a :href="a.edit_link" target="_blank" class="underline-offset-2 hover:underline">{{ a.title }}</a> <span class="text-zinc-400">({{ sourceName(a.source) }}, {{ a.post_status }})</span>
              und
              <a :href="b.edit_link" target="_blank" class="underline-offset-2 hover:underline">{{ b.title }}</a> <span class="text-zinc-400">({{ sourceName(b.source) }}, {{ b.post_status }})</span>
            </li>
          </ul>
        </div>
      </template>
      <p v-else class="mt-2 text-xs text-zinc-500">Prüft, was schon in WordPress steht …</p>
    </section>

    <div class="grid gap-8 lg:grid-cols-[17rem_1fr]">
      <!-- Quellen -->
      <aside class="min-w-0">
        <div class="mb-2 flex items-center">
          <h3 class="eyebrow">Quellen</h3>
          <button v-if="source" class="eyebrow ml-auto hover:!text-zinc-600 dark:hover:!text-zinc-300" @click="source = ''">alle zeigen</button>
        </div>
        <ul class="-mx-2">
          <li v-for="s in state.sources" :key="s.id">
            <div
              class="group rounded-md px-2 py-2 transition-colors"
              :class="source === s.id ? 'bg-zinc-100 dark:bg-zinc-900' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50'"
            >
              <div class="flex items-baseline gap-2">
                <button class="truncate text-left text-sm font-medium" @click="source = source === s.id ? '' : s.id">{{ s.name }}</button>
                <a :href="s.url" target="_blank" class="shrink-0 text-xs text-zinc-400 hover:text-zinc-600" title="Seite öffnen">↗</a>
                <button
                  class="ml-auto shrink-0 text-xs text-zinc-400 opacity-0 hover:text-zinc-700 group-hover:opacity-100 disabled:hidden dark:hover:text-zinc-200"
                  :disabled="state.busy || starting"
                  title="Nur diese Quelle probeweise abrufen"
                  @click="dryRun([s.id])"
                >testen</button>
              </div>
              <template v-for="r in [last?.sources.find((x) => x.id === s.id)]" :key="s.id + 'r'">
                <p v-if="r?.error" class="mt-0.5 break-words text-xs text-rose-600 dark:text-rose-400">{{ r.error }}</p>
                <p v-else-if="r?.skipped" class="mt-0.5 text-xs text-amber-600 dark:text-amber-400">{{ r.skipped }}</p>
                <template v-else-if="r">
                  <p class="mt-0.5 text-xs tabular-nums text-zinc-500">
                    {{ r.found }} gefunden<template v-if="r.sent !== r.found"> · {{ r.found - r.sent }} doppelt</template>
                    <template v-if="r.wp"> · {{ r.wp.created }} neu, {{ r.wp.updated }} aktualisiert<template v-if="r.wp.deleted">, {{ r.wp.deleted }} entfernt</template></template>
                  </p>
                  <p v-if="r.sendError" class="mt-0.5 break-words text-xs text-rose-600 dark:text-rose-400">Übertragen: {{ r.sendError }}</p>
                </template>
                <p v-else class="mt-0.5 text-xs text-zinc-400">{{ s.typ === "seite" ? "Sprachmodell" : s.typ === "ticketmaster" ? "API" : "fester Parser" }} · noch nicht abgerufen</p>
              </template>
            </div>
          </li>
        </ul>
      </aside>

      <!-- Termine -->
      <section class="min-w-0">
        <div class="mb-4 flex flex-wrap gap-2">
          <input v-model="search" class="field max-w-xs" placeholder="Künstler, Location …" />
          <select v-model="city" class="field w-auto">
            <option value="">Alle Orte</option>
            <option v-for="c in cities" :key="c">{{ c }}</option>
          </select>
          <select v-model="country" class="field w-auto">
            <option value="">Alle Länder</option>
            <option v-for="c in countries" :key="c">{{ c }}</option>
          </select>
          <span class="self-center text-xs tabular-nums text-zinc-500">{{ visible.length }} Termine</span>
        </div>

        <!-- Auswahl -->
        <div v-if="abgleich && last" class="sticky top-0 z-10 -mx-2 mb-3 flex flex-wrap items-center gap-2 rounded-md bg-white/90 px-2 py-1.5 text-xs backdrop-blur dark:bg-zinc-950/90">
          <label class="flex items-center gap-2" :class="!visibleSelectable.length && 'opacity-40'">
            <input type="checkbox" :checked="allVisibleSelected" :disabled="!visibleSelectable.length" @change="toggleVisible" />
            neue und geänderte in der Ansicht auswählen ({{ visibleSelectable.length }})
          </label>
          <template v-if="selected.length">
            <span class="ml-auto text-zinc-500">{{ selected.length }} ausgewählt</span>
            <button class="btn h-7 text-xs" @click="selected = []">Aufheben</button>
            <button class="btn btn-primary h-7 text-xs" :disabled="state.busy || starting" @click="transferSelected">Ausgewählte übertragen</button>
          </template>
        </div>

        <p v-if="!last" class="py-6 text-sm text-zinc-500">Noch keine Termine – „Probelauf“ liest alle Quellen, ohne etwas zu übertragen.</p>
        <p v-else-if="!days.length" class="py-6 text-sm text-zinc-500">Keine Termine für diese Auswahl.</p>

        <div v-for="d in days" :key="d.date" class="mb-5">
          <h4 class="eyebrow mb-1">{{ dayLabel(d.date) }}</h4>
          <ul class="divide-y divide-zinc-100 dark:divide-zinc-900">
            <li v-for="e in d.events" :key="e.uid" class="grid grid-cols-[1.25rem_3.5rem_1fr] gap-3 py-2.5 text-sm">
              <input
                v-model="selected"
                type="checkbox"
                class="mt-1"
                :value="e.uid"
                :disabled="!abgleich || !selectable(e.uid)"
                :title="selectable(e.uid) ? 'Zum Übertragen auswählen' : 'Steht schon in WordPress'"
              />
              <span class="tabular-nums text-zinc-500">{{ e.time || "–" }}</span>
              <div class="min-w-0">
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <a v-if="e.url" :href="e.url" target="_blank" class="font-medium underline-offset-2 hover:underline">{{ e.artists.join(", ") || e.title }}</a>
                  <span v-else class="font-medium">{{ e.artists.join(", ") || e.title }}</span>
                  <span v-if="e.status" class="rounded bg-amber-50 px-1.5 text-[11px] leading-4 text-amber-700 dark:bg-amber-950 dark:text-amber-300">{{ e.status }}</span>
                  <span class="ml-auto flex gap-1">
                    <template v-for="c in [checkOf(e.uid)]" :key="e.uid + 'c'">
                      <a
                        v-if="c"
                        :href="c.existing?.edit_link"
                        target="_blank"
                        class="rounded px-1.5 text-[11px] leading-4"
                        :class="[STATES[c.state][1], !c.existing && 'pointer-events-none']"
                        :title="c.changes?.length ? `Ändert: ${c.changes.map((f) => FIELD_LABELS[f] ?? f).join(', ')}` : c.existing ? 'In WordPress öffnen' : ''"
                      >{{ STATES[c.state][0] }}</a>
                    </template>
                    <span class="rounded bg-zinc-100 px-1.5 text-[11px] leading-4 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{{ sourceName(e.source) }}</span>
                  </span>
                </div>
                <p class="text-zinc-600 dark:text-zinc-400">
                  {{ [e.venue, e.city].filter(Boolean).join(", ") }}<template v-if="e.country && e.country !== 'DE'"> ({{ e.country }})</template>
                </p>
                <p v-if="e.info" class="text-xs text-zinc-500">{{ e.info }}</p>
                <p v-if="checkOf(e.uid)?.state === 'dublette'" class="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                  Steht schon in WordPress:
                  <a :href="checkOf(e.uid)!.existing!.edit_link" target="_blank" class="underline underline-offset-2">{{ checkOf(e.uid)!.existing!.title }}</a>
                  ({{ sourceName(checkOf(e.uid)!.existing!.source) }}) – wird nicht nochmal angelegt
                </p>
              </div>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>
