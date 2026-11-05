<script setup lang="ts">
/** Alle Einstellungen – gespeichert in der Datenbank, eine .env braucht es nicht mehr. */
import { computed, onMounted, ref } from "vue";
import { api, type Setup, type Status } from "../api";
import Icon from "./Icon.vue";
import MailAccounts from "./MailAccounts.vue";
import ModelPicker from "./ModelPicker.vue";
import PageHeader from "./PageHeader.vue";
import RegelwerkEditor from "./RegelwerkEditor.vue";
import SettingsSection, { type Field } from "./SettingsSection.vue";

const props = defineProps<{ status: Status }>();
/** setup: Einrichtung öffnen, optional bei einem Schritt */
const emit = defineEmits<{ changed: []; setup: [step?: number] }>();

const setup = ref<Setup | null>(null);
const error = ref("");
async function load() {
  try {
    setup.value = await api.setup();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);
function onSaved(s: Setup) {
  setup.value = s;
  emit("changed");
}
/** ModelPicker neu laden, wenn sich Server-Adressen ändern */
const pickerKey = ref(0);
function onLlmSaved(s: Setup) {
  onSaved(s);
  pickerKey.value++;
}

const CRON_HINT = "Minute Stunde Tag Monat Wochentag – z. B. „0 8,13,18 * * *“ = 8, 13 und 18 Uhr, „0 9 * * 1-5“ = werktags 9 Uhr";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");

const f = {
  website: [
    { path: "site.name", label: "Name der Website", type: "text", placeholder: "Mein Musikblog" },
    { path: "site.tone", label: "Ton und Zielgruppe", type: "textarea", hint: "Geht in jeden Schreibauftrag ans Sprachmodell." },
  ],
  wordpress: [
    { path: "wp.status", label: "Neue Beiträge", type: "select", options: [["publish", "nach Freigabe sofort online"], ["draft", "nach Freigabe als WordPress-Entwurf"], ["pending", "nach Freigabe zur Prüfung"]] },
    { path: "wp.seoPlugin", label: "SEO-Plugin", type: "select", options: [["yoast", "Yoast"], ["rankmath", "Rank Math"], ["none", "keins"]] },
    { path: "wp.categories", label: "Kategorien", type: "text", wide: true, hint: "„Anzeigename=Slug“, mit Komma getrennt – zum Anklicken in der Einrichtung.", placeholder: "News=music-news,Events" },
    { path: "wp.featuredImage", label: "Größtes Bild der Mail als Beitragsbild", type: "toggle", wide: true },
  ],
  mail: [
    { path: "mail.maxAgeDays", label: "Mails der letzten … Tage", type: "number", min: 1, max: 90, hint: "Ältere Mails tauchen im Postfach nicht auf." },
  ],
  publish: [
    { path: "limits.suggestSchedule", label: "Vorschläge mit Benachrichtigung um", type: "cron", hint: CRON_HINT },
    { path: "limits.perRun", label: "Entwürfe pro Testlauf", type: "number", min: 1, max: 20 },
    { path: "limits.timezone", label: "Zeitzone", type: "text", placeholder: "Europe/Berlin" },
  ],
  kalender: [
    { path: "kalender.auto", label: "Täglich automatisch abrufen und übertragen", type: "toggle", wide: true, hint: "Der Mac muss dafür an sein." },
    { path: "kalender.schedule", label: "Abrufen um", type: "cron", hint: "z. B. „30 6 * * *“ = täglich 6:30 Uhr" },
    { path: "kalender.status", label: "Neue Termine", type: "select", options: [["publish", "sofort sichtbar"], ["draft", "erst als Entwurf"]] },
  ],
  llm: [
    { path: "llm.ollamaUrl", label: "Ollama", type: "text", placeholder: "http://127.0.0.1:11434" },
    { path: "llm.mlxUrl", label: "MLX", type: "text", placeholder: "http://127.0.0.1:8080" },
    { path: "llm.opencodeUrl", label: "OpenCode", type: "text", placeholder: "http://127.0.0.1:4096" },
    { path: "llm.openaiUrl", label: "OpenAI-kompatible API", type: "text", placeholder: "https://api.openai.com/v1" },
    { path: "llm.claudeModel", label: "Claude-Modell", type: "text", wide: true, placeholder: "claude-opus-5-5" },
  ],
  keys: [
    { path: "keys.anthropic", label: "Claude (Anthropic)", type: "secret", isSet: "keys.anthropic", placeholder: "sk-ant-…" },
    { path: "keys.openai", label: "ChatGPT (OpenAI)", type: "secret", isSet: "keys.openai", placeholder: "sk-…" },
    { path: "keys.ticketmaster", label: "Ticketmaster", type: "secret", isSet: "keys.ticketmaster", placeholder: "Consumer Key", wide: true, hint: "Für den Konzertkalender – kostenlos bei developer.ticketmaster.com." },
  ],
  server: [
    { path: "server.password", label: "Dashboard-Passwort", type: "secret", isSet: "server.hasPassword", wide: true, hint: "Benutzer „admin“. Pflicht, sobald das Dashboard aus dem Netz erreichbar ist – gilt sofort." },
    { path: "server.host", label: "Adresse", type: "text", placeholder: "127.0.0.1", hint: "127.0.0.1 = nur dieser Mac · 0.0.0.0 = im ganzen Netz" },
    { path: "server.port", label: "Port", type: "number", min: 1, max: 65535 },
  ],
} satisfies Record<string, Field[]>;

const exposed = computed(() => setup.value && !["127.0.0.1", "localhost", "::1"].includes(setup.value.server.host) && !setup.value.server.hasPassword);
</script>

<template>
  <PageHeader title="Einstellungen" description="Alles wird hier eingestellt und in der Datenbank gespeichert – eine .env braucht es nicht.">
    <template #actions>
      <button class="btn btn-primary" @click="emit('setup')"><Icon name="settings" />Einrichtung</button>
    </template>
  </PageHeader>

  <p v-if="error" class="alert alert-error mb-6"><Icon name="alert" class="mt-0.5" />{{ error }}</p>

  <div v-if="!setup" class="grid gap-6 xl:grid-cols-2"><div v-for="n in 4" :key="n" class="skeleton h-48" /></div>

  <div v-else class="grid items-start gap-6 xl:grid-cols-2">
    <div class="space-y-6">
      <section class="card">
        <div class="card-header">
          <Icon name="cpu" class="text-zinc-400" />
          <h2 class="text-sm font-semibold">Sprachmodell</h2>
          <span class="ml-auto truncate text-xs text-zinc-500">{{ props.status.config.model }}</span>
        </div>
        <div class="card-body">
          <ModelPicker :key="pickerKey" @changed="emit('changed')" />
        </div>
      </section>

      <SettingsSection title="API-Keys" icon="cpu" badge="optional" :setup="setup" :fields="f.keys" @saved="onLlmSaved" />
      <SettingsSection title="Server der Sprachmodelle" icon="globe" :setup="setup" :fields="f.llm" @saved="onLlmSaved" />
      <SettingsSection title="Website" icon="music" :setup="setup" :fields="f.website" @saved="onSaved" />

      <SettingsSection title="Dashboard" icon="settings" :setup="setup" :fields="f.server" @saved="onSaved">
        <template #before>
          <p v-if="exposed" class="alert alert-error m-4 mb-0 text-xs"><Icon name="alert" :size="14" class="mt-0.5" />Das Dashboard ist im Netz erreichbar, aber ohne Passwort – bitte eins setzen.</p>
        </template>
        <p class="text-[11px] text-zinc-500 sm:col-span-2">
          Adresse und Port gelten nach einem Neustart des Servers
          <template v-if="setup.server.fromEnv.host || setup.server.fromEnv.port"> – gerade gibt die Umgebung (HOST/PORT) sie vor.</template>
          <template v-else>.</template>
          Datenbank und Datenordner legst du beim Start fest (DB_PATH, DATA_DIR).
        </p>
      </SettingsSection>
    </div>

    <div class="space-y-6">
      <MailAccounts @changed="load(); emit('changed')" />
      <SettingsSection title="Mails" icon="inbox" :setup="setup" :fields="f.mail" @saved="onSaved" />

      <SettingsSection title="WordPress" icon="globe" :setup="setup" :fields="f.wordpress" @saved="onSaved">
        <template #actions>
          <button class="btn btn-sm" @click="emit('setup', 1)"><Icon name="pencil" :size="12" />Zugang</button>
        </template>
        <template #before>
          <div class="flex items-center gap-2 border-b border-zinc-950/15 px-4 py-2.5 text-xs dark:border-white/10">
            <span class="size-2 shrink-0 rounded-full" :class="setup.wp.ready ? 'bg-emerald-500' : 'bg-brand-600'" />
            <span v-if="setup.wp.ready" class="min-w-0 truncate"><b>{{ setup.wp.url }}</b> · {{ setup.wp.user }}</span>
            <span v-else class="text-brand-700 dark:text-brand-300">Noch nicht verbunden – über „Zugang“ einrichten.</span>
          </div>
        </template>
      </SettingsSection>

      <SettingsSection title="Vorschläge und Zeitpläne" icon="clock" :setup="setup" :fields="f.publish" @saved="onSaved">
        <template #before>
          <p class="alert alert-info m-4 mb-0 text-xs">
            <Icon name="check" :size="14" class="mt-0.5" />
            <span>Bühnenpost veröffentlicht <b>nie von selbst</b>. Der Zeitplan bereitet nur Entwürfe vor und benachrichtigt dich – nach WordPress geht ein Beitrag erst, wenn du ihn freigibst.</span>
          </p>
        </template>
        <p class="text-xs text-zinc-500 sm:col-span-2">
          Nächster Vorschlag: <b class="text-zinc-950 dark:text-zinc-100">{{ when(props.status.nextSuggestion) }}</b>
        </p>
      </SettingsSection>

      <SettingsSection v-if="setup.kalender" title="Konzertkalender" icon="calendar" :setup="setup" :fields="f.kalender" @saved="onSaved" />
    </div>

    <div class="xl:col-span-2"><RegelwerkEditor /></div>
  </div>
</template>
