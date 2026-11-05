<script setup lang="ts">
/** Location anlegen oder bearbeiten – landet in kalender/quellen.json. Die Adresse wird vorab geprüft. */
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api, type Erkennung, type KalenderQuelle, type LocationInput } from "../api";
import Icon from "./Icon.vue";

const props = defineProps<{
  /** gesetzt: diese Location bearbeiten, sonst neu anlegen */
  quelle?: KalenderQuelle;
  /** bekannte Orte mit Land – für Vorschläge und das Land automatisch */
  orte: Record<string, string>;
  /** läuft gerade ein Abruf? dann nur speichern, nicht gleich abrufen */
  busy: boolean;
}>();
const emit = defineEmits<{ saved: [quelle: KalenderQuelle, probe: boolean]; deleted: [id: string]; close: [] }>();

const form = reactive<LocationInput>({
  name: props.quelle?.name ?? "",
  url: props.quelle?.url ?? "",
  location: props.quelle?.location && props.quelle.location !== props.quelle.name ? props.quelle.location : "",
  ort: props.quelle?.ort ?? "",
  land: props.quelle?.land ?? "DE",
});
const saving = ref(false);
const error = ref("");
// beim Öffnen gleich ins Adressfeld (autofocus greift nur beim Laden der Seite)
const urlInput = ref<HTMLInputElement | null>(null);
onMounted(() => urlInput.value?.focus());

// bekannter Ort → Land gleich mit setzen
watch(() => form.ort, (ort) => {
  const land = props.orte[ort.trim()];
  if (land) form.land = land;
});
const ortIsNew = computed(() => !!form.ort.trim() && !Object.keys(props.orte).some((o) => o.toLowerCase() === form.ort.trim().toLowerCase()));

// ---- Seite prüfen: Parser, Termine, Vorschläge für Name/Ort/Land
const erkennung = ref<Erkennung | null>(null);
const checking = ref(false);
let checkedUrl = props.quelle?.url ?? "";
let timer: ReturnType<typeof setTimeout> | undefined;

const validUrl = (u: string) => {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};

async function check(url = form.url.trim()) {
  if (!validUrl(url)) return;
  checkedUrl = url;
  checking.value = true;
  try {
    const e = await api.erkennen(url, props.quelle?.id);
    if (form.url.trim() !== url) return; // inzwischen weitergetippt
    erkennung.value = e;
    // nur leere Felder füllen – was du eingetragen hast, bleibt
    if (!form.name && e.vorschlag.name) form.name = e.vorschlag.name;
    if (!form.ort && e.vorschlag.ort) form.ort = e.vorschlag.ort;
    if (e.vorschlag.land && (!props.orte[form.ort] || form.ort === e.vorschlag.ort)) form.land = e.vorschlag.land;
  } catch (e) {
    erkennung.value = { typ: "seite", urteil: "ungeeignet", hinweis: (e as Error).message, termine: 0, vorschlag: {}, programmLinks: [] };
  } finally {
    checking.value = false;
  }
}

watch(() => form.url, (url) => {
  clearTimeout(timer);
  if (url.trim() === checkedUrl) return;
  erkennung.value = null;
  timer = setTimeout(() => check(), 700);
});

function useLink(url: string) {
  form.url = url;
  clearTimeout(timer);
  check(url);
}

const PARSER = { seite: "Sprachmodell", regioactive: "regioactive.de · fester Parser" } as const;
const URTEIL = {
  gut: ["alert-ok", "check"],
  unsicher: ["alert-warn", "alert"],
  ungeeignet: ["alert-error", "x"],
} as const;

const LAENDER = ["DE", "CH", "FR", "AT"];

async function save(probe: boolean) {
  saving.value = true;
  error.value = "";
  try {
    const q = props.quelle ? await api.updateLocation(props.quelle.id, form) : await api.addLocation(form);
    emit("saved", q, probe);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!props.quelle || !confirm(`„${props.quelle.name}“ aus den Quellen löschen?\n\nSchon übertragene Termine bleiben in WordPress stehen.`)) return;
  saving.value = true;
  try {
    await api.deleteLocation(props.quelle.id);
    emit("deleted", props.quelle.id);
  } catch (e) {
    error.value = (e as Error).message;
    saving.value = false;
  }
}
</script>

<template>
  <form class="space-y-3 border-b border-zinc-950 bg-zinc-950/[0.03] p-4 dark:border-white/30 dark:bg-white/[0.03]" @submit.prevent="save(!busy)">
    <div class="flex items-center gap-2">
      <p class="eyebrow mr-auto">{{ quelle ? "Location bearbeiten" : "Neue Location" }}</p>
      <button type="button" class="opacity-60 hover:opacity-100" title="Schließen" @click="emit('close')"><Icon name="x" :size="14" /></button>
    </div>

    <div>
      <label class="label" for="loc-url">
        Programm-Seite
        <button v-if="validUrl(form.url)" type="button" class="font-semibold tracking-normal normal-case underline-offset-2 hover:underline" :disabled="checking" @click="check()">
          {{ checking ? "prüft …" : "prüfen" }}
        </button>
      </label>
      <input id="loc-url" v-model.trim="form.url" ref="urlInput" class="field" type="url" placeholder="https://…/programm" required />
      <p v-if="!erkennung && !checking" class="mt-1 text-[11px] text-zinc-500">Adresse einfügen – die Seite wird geprüft und Name, Ort und Land vorgeschlagen.</p>
    </div>

    <!-- Ergebnis der Prüfung -->
    <div v-if="checking" class="flex items-center gap-2 text-xs text-zinc-500">
      <Icon name="refresh" :size="12" class="animate-spin" />Seite wird abgerufen und geprüft …
    </div>
    <div v-else-if="erkennung" class="alert py-2 text-xs" :class="URTEIL[erkennung.urteil][0]">
      <Icon :name="URTEIL[erkennung.urteil][1]" :size="14" class="mt-0.5" />
      <div class="min-w-0 flex-1 space-y-1.5">
        <p class="flex flex-wrap items-center gap-1.5">
          <span class="badge" :class="erkennung.typ === 'regioactive' ? 'badge-sky' : ''">{{ PARSER[erkennung.typ] }}</span>
          <span v-if="erkennung.termine" class="font-semibold tabular-nums">{{ erkennung.termine }} {{ erkennung.typ === "regioactive" ? "Termine" : "Datumsangaben" }}</span>
        </p>
        <p>{{ erkennung.hinweis }}</p>
        <div v-if="erkennung.programmLinks.length" class="flex flex-wrap gap-1.5 pt-0.5">
          <button v-for="l in erkennung.programmLinks" :key="l.url" type="button" class="btn btn-sm" :title="l.url" @click="useLink(l.url)">
            <Icon name="chevron" :size="12" />{{ l.text }}
          </button>
        </div>
      </div>
    </div>

    <div>
      <label class="label" for="loc-name">Name</label>
      <input id="loc-name" v-model="form.name" class="field" placeholder="z. B. Jazzhaus" required />
    </div>

    <div class="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
      <div>
        <label class="label" for="loc-ort">Ort</label>
        <input id="loc-ort" v-model="form.ort" class="field" list="loc-orte" placeholder="Freiburg" required />
        <datalist id="loc-orte">
          <option v-for="(_, o) in orte" :key="o" :value="o" />
        </datalist>
      </div>
      <div>
        <label class="label" for="loc-land">Land</label>
        <select id="loc-land" v-model="form.land" class="field">
          <option v-for="l in LAENDER" :key="l">{{ l }}</option>
          <option v-if="!LAENDER.includes(form.land)">{{ form.land }}</option>
        </select>
      </div>
    </div>
    <p v-if="ortIsNew" class="-mt-1 text-[11px] text-zinc-500">„{{ form.ort.trim() }}“ ist neu und kommt beim Speichern mit in die Orte.</p>

    <div>
      <label class="label" for="loc-location">Name in den Terminen <span class="font-normal tracking-normal normal-case text-zinc-500">optional</span></label>
      <input id="loc-location" v-model="form.location" class="field" :placeholder="form.name || 'wie der Name'" />
    </div>

    <p v-if="error" class="alert alert-error text-xs"><Icon name="alert" :size="14" class="mt-0.5" />{{ error }}</p>

    <div class="flex flex-wrap items-center gap-2 pt-1">
      <button type="submit" class="btn btn-primary btn-sm" :disabled="saving" :title="busy ? 'Ein Abruf läuft gerade – es wird nur gespeichert' : 'Speichern und gleich testweise abrufen, ohne etwas zu übertragen'">
        <Icon :name="busy ? 'save' : 'download'" :size="12" />{{ busy ? "Speichern" : "Speichern & abrufen" }}
      </button>
      <button v-if="!busy" type="button" class="btn btn-sm" :disabled="saving" @click="save(false)">Nur speichern</button>
      <button v-if="quelle" type="button" class="btn btn-ghost btn-danger btn-sm ml-auto" :disabled="saving" @click="remove">
        <Icon name="trash" :size="12" />Löschen
      </button>
    </div>
  </form>
</template>
