<script setup lang="ts">
/** Postfach anlegen oder bearbeiten: Server wird aus der Adresse erkannt, Verbindung und Ordner geprüft. */
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api, type ConnectionTest, type MailAccount, type MailAccountInput, type ServerGuess } from "../api";
import Icon from "./Icon.vue";

const props = defineProps<{ account?: MailAccount }>();
const emit = defineEmits<{ saved: [accounts: MailAccount[]]; close: [] }>();

const form = reactive<MailAccountInput>({
  name: props.account && props.account.name !== props.account.user ? props.account.name : "",
  user: props.account?.user ?? "",
  password: "",
  host: props.account?.host ?? "",
  port: props.account?.port ?? 993,
  folder: props.account?.folder ?? "INBOX",
  processedFolder: props.account?.processedFolder ?? "",
});
const saving = ref(false);
const error = ref("");
const userInput = ref<HTMLInputElement | null>(null);
onMounted(() => userInput.value?.focus());

// ---- Server aus der Mail-Adresse erkennen (nur solange niemand den Server selbst eingetragen hat)
const guess = ref<ServerGuess | null>(null);
let hostTouched = !!props.account;
let guessTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => form.user, (user) => {
  clearTimeout(guessTimer);
  if (hostTouched || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(user.trim())) return;
  guessTimer = setTimeout(async () => {
    const g = await api.guessMailServer(user.trim()).catch(() => null);
    if (!g || hostTouched || form.user !== user) return;
    guess.value = g;
    form.host = g.host;
    form.port = g.port;
  }, 500);
});
const onHostInput = () => {
  hostTouched = true;
  guess.value = null;
};

// ---- Verbindung testen: Anmeldung, Ordnerliste, gewählter Ordner
const test = ref<ConnectionTest | null>(null);
const testing = ref(false);
/** gespeichertes Passwort gilt nur für denselben Server und Benutzer */
const storedPwUsable = computed(() => !!props.account?.hasPassword && form.host.trim() === props.account.host && form.user.trim() === props.account.user);
const canTest = computed(() => form.user.trim() && form.host.trim() && (form.password || storedPwUsable.value));
async function runTest() {
  testing.value = true;
  try {
    test.value = await api.testMailAccount(form, props.account?.nr);
    // Ordner gibt es nicht, aber INBOX: darauf ausweichen
    if (!test.value.ok && test.value.folders.length && !test.value.folders.includes(form.folder)) form.folder = "INBOX";
  } catch (e) {
    test.value = { ok: false, error: (e as Error).message, folders: [] };
  } finally {
    testing.value = false;
  }
}
// Zugangsdaten geändert → altes Testergebnis gilt nicht mehr
watch(() => [form.user, form.password, form.host, form.port], () => (test.value = null));
const folders = computed(() => {
  const list = test.value?.folders ?? [];
  return [...new Set([...list, form.folder, form.processedFolder].filter(Boolean))];
});

async function save() {
  saving.value = true;
  error.value = "";
  try {
    emit("saved", props.account ? await api.updateMailAccount(props.account.nr, form) : await api.addMailAccount(form));
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="space-y-3 border-b border-zinc-950 bg-zinc-950/[0.03] p-4 dark:border-white/30 dark:bg-white/[0.03]" @submit.prevent="save">
    <div class="flex items-center gap-2">
      <p class="eyebrow mr-auto">{{ account ? "Postfach bearbeiten" : "Neues Postfach" }}</p>
      <button type="button" class="opacity-60 hover:opacity-100" title="Schließen" @click="emit('close')"><Icon name="x" :size="14" /></button>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label class="label" for="acc-user">Mail-Adresse / Benutzer</label>
        <input id="acc-user" ref="userInput" v-model.trim="form.user" class="field" autocomplete="off" placeholder="presse@example.com" required />
      </div>
      <div>
        <label class="label" for="acc-pw">Passwort</label>
        <input id="acc-pw" v-model="form.password" class="field" type="password" autocomplete="new-password"
          :placeholder="storedPwUsable ? 'unverändert' : 'App-Passwort'" :required="!storedPwUsable" />
      </div>
    </div>

    <div class="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
      <div>
        <label class="label" for="acc-host">
          IMAP-Server
          <span v-if="guess" class="font-normal tracking-normal normal-case text-zinc-500">erkannt · {{ guess.quelle }}</span>
        </label>
        <input id="acc-host" v-model.trim="form.host" class="field" placeholder="imap.example.com" required @input="onHostInput" />
      </div>
      <div>
        <label class="label" for="acc-port">Port</label>
        <input id="acc-port" v-model.number="form.port" class="field" type="number" min="1" max="65535" required @input="onHostInput" />
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-sm" :disabled="!canTest || testing" @click="runTest">
        <Icon name="refresh" :size="12" :class="testing && 'animate-spin'" />{{ testing ? "verbindet …" : "Verbindung testen" }}
      </button>
      <span v-if="!test && !testing" class="text-[11px] text-zinc-500">prüft Anmeldung und lädt die Ordner</span>
    </div>
    <p v-if="test" class="alert py-2 text-xs" :class="test.ok ? 'alert-ok' : 'alert-error'">
      <Icon :name="test.ok ? 'check' : 'alert'" :size="14" class="mt-0.5" />
      <span v-if="test.ok">Verbunden – {{ test.folders.length }} Ordner, {{ test.messages ?? "?" }} Mails in „{{ form.folder }}“.</span>
      <span v-else>{{ test.error }}</span>
    </p>

    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label class="label" for="acc-folder">Ordner mit Pressemitteilungen</label>
        <select v-if="test?.folders.length" id="acc-folder" v-model="form.folder" class="field">
          <option v-for="f in folders" :key="f">{{ f }}</option>
        </select>
        <input v-else id="acc-folder" v-model.trim="form.folder" class="field" placeholder="INBOX" />
      </div>
      <div>
        <label class="label" for="acc-done">Erledigte verschieben nach <span class="font-normal tracking-normal normal-case text-zinc-500">optional</span></label>
        <select v-if="test?.folders.length" id="acc-done" v-model="form.processedFolder" class="field">
          <option value="">– nicht verschieben –</option>
          <option v-for="f in folders.filter((x) => x !== form.folder)" :key="f">{{ f }}</option>
        </select>
        <input v-else id="acc-done" v-model.trim="form.processedFolder" class="field" placeholder="nicht verschieben" />
      </div>
    </div>

    <div>
      <label class="label" for="acc-name">Anzeigename <span class="font-normal tracking-normal normal-case text-zinc-500">optional</span></label>
      <input id="acc-name" v-model="form.name" class="field" :placeholder="form.user || 'wie die Adresse'" />
    </div>

    <p v-if="error" class="alert alert-error text-xs"><Icon name="alert" :size="14" class="mt-0.5" />{{ error }}</p>

    <div class="flex flex-wrap items-center gap-2 pt-1">
      <button type="submit" class="btn btn-primary btn-sm" :disabled="saving"><Icon name="save" :size="12" />Speichern</button>
      <span v-if="test && !test.ok" class="text-[11px] text-zinc-500">Speichern geht trotzdem – der Abruf zeigt den Fehler dann im Postfach an.</span>
    </div>
  </form>
</template>
