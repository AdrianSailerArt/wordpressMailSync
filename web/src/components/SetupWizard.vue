<script setup lang="ts">
/**
 * Einrichtung in sechs Schritten: Website, WordPress, Postfächer, Sprachmodell, Konzertkalender, fertig.
 * Jeder Schritt speichert beim „Weiter“ und lässt sich überspringen – API-Keys sind alle optional.
 */
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api, type Setup, type WpTest } from "../api";
import Icon from "./Icon.vue";
import MailAccounts from "./MailAccounts.vue";
import ModelPicker from "./ModelPicker.vue";

const props = defineProps<{ start?: number }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const setup = ref<Setup | null>(null);
const step = ref(props.start ?? 0);
const saving = ref(false);
const error = ref("");
const activeModel = ref("");

const STEPS = [
  { id: "website", title: "Website", hint: "Name und Ton" },
  { id: "wordpress", title: "WordPress", hint: "Zugang zum Blog" },
  { id: "postfaecher", title: "Postfächer", hint: "Wo die Mails ankommen" },
  { id: "modell", title: "Sprachmodell", hint: "Wer die Texte schreibt" },
  { id: "kalender", title: "Konzertkalender", hint: "optional" },
  { id: "fertig", title: "Fertig", hint: "Überblick" },
] as const;

// ---- Formularwerte (Geheimnisse bleiben leer = unverändert)
const site = reactive({ name: "", tone: "" });
const wp = reactive({ url: "", user: "", appPassword: "", seoPlugin: "none" as Setup["wp"]["seoPlugin"], status: "publish" as Setup["wp"]["status"] });
const keys = reactive({ anthropic: "", openai: "", ticketmaster: "" });

async function load() {
  setup.value = await api.setup();
  const s = setup.value;
  Object.assign(site, s.site);
  Object.assign(wp, { url: s.wp.url, user: s.wp.user, appPassword: "", seoPlugin: s.wp.seoPlugin, status: s.wp.status });
  selected.value = parseCategories(s.wp.categories);
  activeModel.value = (await api.status().catch(() => null))?.config.activeModel ?? "";
}
onMounted(() => load().catch((e) => (error.value = (e as Error).message)));

// ---- WordPress: Verbindung prüfen, Kategorien wählen
const wpTest = ref<WpTest | null>(null);
const testingWp = ref(false);
/** gewählte Kategorien: Anzeigename → Slug (leer: über den Namen suchen) */
const selected = ref<Record<string, string>>({});

function parseCategories(value: string): Record<string, string> {
  return Object.fromEntries(value.split(",").map((e) => e.split("=").map((x) => x.trim())).filter(([n]) => n).map(([n, slug]) => [n!, slug ?? ""]));
}
const categoriesString = computed(() => Object.entries(selected.value).map(([n, slug]) => (slug ? `${n}=${slug}` : n)).join(","));
const isSelected = (slug: string) => Object.values(selected.value).includes(slug);
function toggleCategory(c: { name: string; slug: string }) {
  const next = { ...selected.value };
  const key = Object.keys(next).find((k) => next[k] === c.slug || (!next[k] && k === c.name));
  if (key) delete next[key];
  else next[c.name] = c.slug;
  selected.value = next;
}

/** gespeichertes Passwort gilt nur für dieselbe Adresse und denselben Benutzer */
const normUrl = (u: string) => u.trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)(?=.)/, "https://");
const storedPwUsable = computed(() => !!setup.value?.wp.hasAppPassword && normUrl(wp.url) === setup.value.wp.url && wp.user === setup.value.wp.user);
const wpUrlValid = computed(() => /^(https?:\/\/)?[^\s/]+\.[^\s/]+/.test(wp.url.trim()));
const appPasswordLink = computed(() => `${wp.url.trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://")}/wp-admin/profile.php#application-passwords-section`);

async function testWp() {
  testingWp.value = true;
  try {
    wpTest.value = await api.testWordPress({ url: wp.url, user: wp.user, appPassword: wp.appPassword });
    if (wpTest.value.ok && wpTest.value.seoPlugin) wp.seoPlugin = wpTest.value.seoPlugin;
    // noch nichts gewählt: die drei meistgenutzten Kategorien vorschlagen
    if (wpTest.value.ok && !Object.keys(selected.value).length)
      selected.value = Object.fromEntries(wpTest.value.categories.filter((c) => c.slug !== "uncategorized" && c.slug !== "allgemein").slice(0, 3).map((c) => [c.name, c.slug]));
  } catch (e) {
    wpTest.value = { ok: false, error: (e as Error).message, categories: [] };
  } finally {
    testingWp.value = false;
  }
}
watch(() => [wp.url, wp.user, wp.appPassword], () => (wpTest.value = null));

// ---- Schritte speichern
async function saveStep(): Promise<boolean> {
  const id = STEPS[step.value]!.id;
  const body =
    id === "website" ? { site: { ...site } }
    : id === "wordpress" ? { wp: { url: wp.url, user: wp.user, appPassword: wp.appPassword, seoPlugin: wp.seoPlugin, status: wp.status, categories: categoriesString.value } }
    : id === "modell" ? { keys: { anthropic: keys.anthropic, openai: keys.openai } }
    : id === "kalender" ? { keys: { ticketmaster: keys.ticketmaster } }
    : null;
  if (!body) return true;
  saving.value = true;
  error.value = "";
  try {
    setup.value = await api.saveSetup(body);
    keys.anthropic = keys.openai = keys.ticketmaster = wp.appPassword = "";
    emit("changed");
    return true;
  } catch (e) {
    error.value = (e as Error).message;
    return false;
  } finally {
    saving.value = false;
  }
}

async function next() {
  if (await saveStep()) step.value = Math.min(step.value + 1, STEPS.length - 1);
}
const skip = () => (step.value = Math.min(step.value + 1, STEPS.length - 1));

/** Key entfernen (null löscht ihn) */
async function removeKey(name: "anthropic" | "openai" | "ticketmaster") {
  setup.value = await api.saveSetup({ keys: { [name]: null } });
  pickerKey.value++;
  emit("changed");
}
/** ModelPicker neu laden, wenn sich Keys ändern – Claude/ChatGPT werden dann wählbar */
const pickerKey = ref(0);
async function saveKeys() {
  if (await saveStep()) pickerKey.value++;
}

async function finish() {
  saving.value = true;
  try {
    await api.saveSetup({ done: true });
    emit("changed");
    emit("close");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

const summary = computed(() => {
  const s = setup.value;
  if (!s) return [];
  return [
    { label: "Website", ok: !!s.site.name, text: s.site.name || "kein Name", step: 0 },
    { label: "WordPress", ok: s.wp.ready, text: s.wp.ready ? s.wp.url : "nicht eingerichtet – Beiträge lassen sich nicht veröffentlichen", step: 1 },
    { label: "Postfächer", ok: s.mailAccounts > 0, text: s.mailAccounts ? `${s.mailAccounts} eingerichtet` : "keins – es kommen keine Mails an", step: 2 },
    { label: "Sprachmodell", ok: !!activeModel.value, text: [activeModel.value || "lokales Modell", s.keys.anthropic && "Claude-Key", s.keys.openai && "OpenAI-Key"].filter(Boolean).join(" · "), step: 3 },
    { label: "Ticketmaster", ok: s.keys.ticketmaster, text: s.keys.ticketmaster ? "Key gespeichert" : "ohne – optional", step: 4, optional: true },
  ];
});
</script>

<template>
  <div class="fixed inset-0 z-50 overflow-y-auto bg-paper dark:bg-paper-dark" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <div class="mx-auto flex min-h-full max-w-5xl flex-col px-4 py-8 sm:px-6 lg:py-12">
      <header class="mb-8 flex items-start gap-4">
        <img src="/icon.svg" alt="" class="size-10" />
        <div class="mr-auto">
          <p class="eyebrow text-zinc-600 dark:text-zinc-400">Bühnenpost</p>
          <h1 id="setup-title" class="page-title mt-2">Einrichtung</h1>
        </div>
        <button class="btn btn-ghost btn-sm" title="Einrichtung schließen – du kannst sie unter Einstellungen wieder öffnen" @click="emit('close')">
          <Icon name="x" :size="14" />Später
        </button>
      </header>

      <div class="grid flex-1 items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <!-- Schritte -->
        <ol class="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-1.5 lg:overflow-visible">
          <li v-for="(s, i) in STEPS" :key="s.id" class="shrink-0">
            <button
              class="flex w-full cursor-pointer items-center gap-3 border px-3 py-2 text-left transition-all duration-200"
              :class="step === i
                ? '-rotate-1 border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950'
                : 'border-transparent text-zinc-800 hover:border-zinc-950 dark:text-zinc-300 dark:hover:border-white/60'"
              :aria-current="step === i ? 'step' : undefined"
              @click="step = i"
            >
              <span class="w-6 text-lg leading-none font-black tabular-nums" :class="step === i ? 'text-brand-400 dark:text-brand-600' : 'text-brand-600 dark:text-brand-400'">{{ String(i + 1).padStart(2, "0") }}</span>
              <span class="min-w-0">
                <span class="block text-sm font-bold whitespace-nowrap">{{ s.title }}</span>
                <span class="hidden truncate text-[11px] lg:block" :class="step === i ? 'text-white/60 dark:text-zinc-950/60' : 'text-zinc-500'">{{ s.hint }}</span>
              </span>
            </button>
          </li>
        </ol>

        <!-- Inhalt -->
        <section class="card min-w-0">
          <div v-if="!setup" class="card-body space-y-3"><div class="skeleton h-6 w-48" /><div class="skeleton h-24 w-full" /></div>

          <template v-else>
            <!-- 1 Website -->
            <div v-if="step === 0" class="card-body space-y-4">
              <div>
                <h2 class="text-xl font-extrabold tracking-tight">Für welche Website schreibt Bühnenpost?</h2>
                <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Name und Ton gehen in jeden Schreibauftrag ans Sprachmodell.</p>
              </div>
              <div>
                <label class="label" for="s-name">Name der Website</label>
                <input id="s-name" v-model="site.name" class="field" placeholder="z. B. Mein Musikblog" />
              </div>
              <div>
                <label class="label" for="s-tone">Ton und Zielgruppe</label>
                <textarea id="s-tone" v-model="site.tone" class="field min-h-24" placeholder="locker, kompetent, für Konzertgänger im deutschsprachigen Raum" />
              </div>
            </div>

            <!-- 2 WordPress -->
            <div v-else-if="step === 1" class="card-body space-y-4">
              <div>
                <h2 class="text-xl font-extrabold tracking-tight">WordPress verbinden</h2>
                <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Bühnenpost veröffentlicht über die REST-API mit einem <b>Anwendungspasswort</b> – nicht mit deinem Login-Passwort.
                  Am besten ein eigener Benutzer mit der Rolle „Autor“ oder „Redakteur“.
                </p>
              </div>
              <div>
                <label class="label" for="s-url">Adresse der Website</label>
                <input id="s-url" v-model.trim="wp.url" class="field" placeholder="https://www.example.com" />
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div>
                  <label class="label" for="s-user">Benutzername</label>
                  <input id="s-user" v-model.trim="wp.user" class="field" autocomplete="off" placeholder="pressbot" />
                </div>
                <div>
                  <label class="label" for="s-pw">
                    Anwendungspasswort
                    <a v-if="wpUrlValid" :href="appPasswordLink" target="_blank" class="font-semibold tracking-normal normal-case underline underline-offset-2">anlegen ↗</a>
                  </label>
                  <input id="s-pw" v-model="wp.appPassword" class="field font-mono" type="password" autocomplete="new-password"
                    :placeholder="storedPwUsable ? 'gespeichert – leer lassen' : 'xxxx xxxx xxxx xxxx xxxx xxxx'" />
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <button class="btn btn-sm" :disabled="testingWp || !wp.url || !wp.user || (!wp.appPassword && !storedPwUsable)" @click="testWp">
                  <Icon name="refresh" :size="12" :class="testingWp && 'animate-spin'" />{{ testingWp ? "verbindet …" : "Verbindung testen" }}
                </button>
                <span v-if="!wpTest && !testingWp" class="text-[11px] text-zinc-500">prüft Anmeldung und Rechte, lädt Kategorien und erkennt Plugins</span>
              </div>

              <div v-if="wpTest" class="alert py-2 text-xs" :class="!wpTest.ok ? 'alert-error' : wpTest.canPublish ? 'alert-ok' : 'alert-warn'">
                <Icon :name="wpTest.ok ? 'check' : 'alert'" :size="14" class="mt-0.5" />
                <div v-if="wpTest.ok" class="space-y-1">
                  <p>Angemeldet als <b>{{ wpTest.name }}</b>.<template v-if="!wpTest.canPublish"> Dieser Benutzer darf nicht veröffentlichen oder keine Bilder hochladen – Rolle „Autor“ oder höher geben.</template></p>
                  <p>SEO-Plugin: <b>{{ { yoast: "Yoast", rankmath: "Rank Math", none: "keins erkannt" }[wpTest.seoPlugin ?? "none"] }}</b> · Konzertkalender-Plugin: <b>{{ wpTest.kalender ? "aktiv" : "nicht installiert" }}</b></p>
                </div>
                <p v-else>{{ wpTest.error }}</p>
              </div>

              <div>
                <p class="label">Kategorien, aus denen das Modell wählt</p>
                <div v-if="wpTest?.ok && wpTest.categories.length" class="flex flex-wrap gap-1.5">
                  <button v-for="c in wpTest.categories" :key="c.slug" type="button" class="cat-chip" :class="isSelected(c.slug) && 'cat-chip-on'" @click="toggleCategory(c)">
                    {{ c.name }} <span class="opacity-60">{{ c.count }}</span>
                  </button>
                </div>
                <template v-else>
                  <input :value="categoriesString" class="field" placeholder="News=music-news,Events" @change="selected = parseCategories(($event.target as HTMLInputElement).value)" />
                  <p class="mt-1 text-[11px] text-zinc-500">„Anzeigename=Slug“, mit Komma getrennt – nach „Verbindung testen“ zum Anklicken.</p>
                </template>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div>
                  <label class="label" for="s-status">Neue Beiträge</label>
                  <select id="s-status" v-model="wp.status" class="field">
                    <option value="publish">nach Freigabe sofort online</option>
                    <option value="draft">nach Freigabe als WordPress-Entwurf</option>
                    <option value="pending">nach Freigabe zur Prüfung</option>
                  </select>
                </div>
                <div>
                  <label class="label" for="s-seo">SEO-Plugin</label>
                  <select id="s-seo" v-model="wp.seoPlugin" class="field">
                    <option value="yoast">Yoast</option>
                    <option value="rankmath">Rank Math</option>
                    <option value="none">keins</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- 3 Postfächer -->
            <div v-else-if="step === 2" class="space-y-4">
              <div class="card-body pb-0">
                <h2 class="text-xl font-extrabold tracking-tight">Postfächer mit Pressemitteilungen</h2>
                <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Adresse und Passwort eintragen – der Server wird erkannt, „Verbindung testen“ lädt die Ordner. Mehrere Postfächer gehen auch; doppelte Mails werden zusammengefasst.</p>
              </div>
              <div class="px-4 pb-4"><MailAccounts @changed="load(); emit('changed')" /></div>
            </div>

            <!-- 4 Sprachmodell -->
            <div v-else-if="step === 3" class="card-body space-y-5">
              <div>
                <h2 class="text-xl font-extrabold tracking-tight">Wer schreibt die Texte?</h2>
                <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Lokal (Ollama, MLX, OpenCode) kostenlos auf deinem Mac – oder mit API-Key über Claude bzw. ChatGPT. Die Keys sind optional.</p>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div v-for="k in ([['anthropic', 'Claude (Anthropic)', 'sk-ant-…', 'https://console.anthropic.com/settings/keys'], ['openai', 'ChatGPT (OpenAI)', 'sk-…', 'https://platform.openai.com/api-keys']] as const)" :key="k[0]">
                  <label class="label" :for="`s-${k[0]}`">
                    {{ k[1] }} <span class="font-normal tracking-normal normal-case text-zinc-500">optional</span>
                  </label>
                  <input :id="`s-${k[0]}`" v-model="keys[k[0]]" class="field font-mono" type="password" autocomplete="off"
                    :placeholder="setup.keys[k[0]] ? 'gespeichert – leer lassen' : k[2]" />
                  <p class="mt-1 flex gap-2 text-[11px] text-zinc-500">
                    <a :href="k[3]" target="_blank" class="underline underline-offset-2">Key anlegen ↗</a>
                    <button v-if="setup.keys[k[0]]" type="button" class="text-brand-700 underline underline-offset-2 dark:text-brand-300" @click="removeKey(k[0])">Key entfernen</button>
                  </p>
                </div>
              </div>
              <button v-if="keys.anthropic || keys.openai" class="btn btn-sm" :disabled="saving" @click="saveKeys"><Icon name="save" :size="12" />Keys speichern</button>

              <div>
                <p class="label">Modell wählen</p>
                <ModelPicker :key="pickerKey" @changed="(m) => (activeModel = m)" />
              </div>
            </div>

            <!-- 5 Konzertkalender -->
            <div v-else-if="step === 4" class="card-body space-y-4">
              <div>
                <h2 class="text-xl font-extrabold tracking-tight">Konzertkalender <span class="badge align-middle">optional</span></h2>
                <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Termine von Clubs und Veranstaltern landen über das WordPress-Plugin „Konzertkalender“ auf deiner Website.
                  Locations und Orte pflegst du später im Reiter <b>Konzertkalender</b>.
                </p>
              </div>
              <div>
                <label class="label" for="s-tm">Ticketmaster-Key <span class="font-normal tracking-normal normal-case text-zinc-500">optional, kostenlos</span></label>
                <input id="s-tm" v-model="keys.ticketmaster" class="field font-mono" type="password" autocomplete="off"
                  :placeholder="setup.keys.ticketmaster ? 'gespeichert – leer lassen' : 'Consumer Key'" />
                <p class="mt-1 flex gap-2 text-[11px] text-zinc-500">
                  <a href="https://developer.ticketmaster.com/" target="_blank" class="underline underline-offset-2">Key bei developer.ticketmaster.com ↗</a>
                  <button v-if="setup.keys.ticketmaster" type="button" class="text-brand-700 underline underline-offset-2 dark:text-brand-300" @click="removeKey('ticketmaster')">Key entfernen</button>
                </p>
              </div>
            </div>

            <!-- 6 Fertig -->
            <div v-else class="card-body space-y-4">
              <div>
                <h2 class="text-xl font-extrabold tracking-tight">Überblick</h2>
                <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Alles lässt sich später unter <b>Einstellungen → Einrichtung</b> ändern.</p>
              </div>
              <ul class="divide-y divide-zinc-950/15 border border-zinc-950 dark:divide-white/10 dark:border-white/40">
                <li v-for="r in summary" :key="r.label" class="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <span class="flex size-5 shrink-0 items-center justify-center border" :class="r.ok ? 'border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950' : r.optional ? 'border-zinc-950/30 text-zinc-400' : 'border-brand-600 text-brand-600'">
                    <Icon :name="r.ok ? 'check' : r.optional ? 'skip' : 'alert'" :size="12" />
                  </span>
                  <span class="w-28 shrink-0 font-semibold">{{ r.label }}</span>
                  <span class="min-w-0 flex-1 truncate" :class="r.ok || r.optional ? 'text-zinc-600 dark:text-zinc-400' : 'text-brand-700 dark:text-brand-300'">{{ r.text }}</span>
                  <button v-if="!r.ok" class="text-xs underline underline-offset-2" @click="step = r.step">ändern</button>
                </li>
              </ul>
            </div>

            <p v-if="error" class="alert alert-error mx-4 mb-4 text-xs"><Icon name="alert" :size="14" class="mt-0.5" />{{ error }}</p>

            <!-- Navigation -->
            <div class="flex flex-wrap items-center gap-2 border-t border-zinc-950 px-4 py-3 dark:border-white/30">
              <button v-if="step > 0" class="btn btn-ghost btn-sm" @click="step--"><Icon name="chevron" :size="12" class="rotate-180" />Zurück</button>
              <span class="mr-auto" />
              <template v-if="step < STEPS.length - 1">
                <button v-if="step !== 2" class="btn btn-ghost btn-sm" @click="skip">Überspringen</button>
                <button class="btn btn-primary" :disabled="saving" @click="next">{{ step === 2 ? "Weiter" : "Speichern & weiter" }}<Icon name="chevron" :size="14" /></button>
              </template>
              <button v-else class="btn btn-primary" :disabled="saving" @click="finish"><Icon name="check" :size="14" />Einrichtung abschließen</button>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>
