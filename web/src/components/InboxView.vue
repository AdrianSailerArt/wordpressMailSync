<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { api, formatDate, type Article, type MailImages, type MailSummary, type OriginalMail, type Status } from "../api";
import { live } from "../llm";
import ArticleEditor from "./ArticleEditor.vue";
import LiveOutput from "./LiveOutput.vue";

const props = defineProps<{ status: Status | null; openUid?: number | null }>();
const emit = defineEmits<{ changed: []; opened: [] }>();

const mails = ref<MailSummary[]>([]);
const loading = ref(true);
const error = ref("");
const selected = ref<MailSummary | null>(null);
const article = ref<Article | null>(null);
const original = ref<OriginalMail | null>(null);
const images = ref<MailImages | null>(null);
const filter = ref<"all" | "drafts">("all");
const visible = computed(() => (filter.value === "drafts" ? mails.value.filter((m) => m.hasDraft) : mails.value));
const draftCount = computed(() => mails.value.filter((m) => m.hasDraft).length);
const busy = ref<"" | "preview" | "publish" | "skip" | "save">("");
const notice = ref("");
const detail = ref<HTMLElement | null>(null);
/** Läuft für die ausgewählte Mail gerade das Modell (per Klick oder vom Zeitplan)? */
const liveRun = computed(() => (selected.value ? live.runs[selected.value.uid] ?? null : null));

const limitReached = computed(() => (props.status ? props.status.today >= props.status.limit : false));

async function load() {
  loading.value = true;
  try {
    mails.value = await api.mails();
    error.value = "";
    // aus einer Benachrichtigung geöffnet → passende Mail direkt anzeigen
    const target = props.openUid && mails.value.find((m) => m.uid === props.openUid);
    if (target) {
      filter.value = "drafts";
      emit("opened");
      select(target);
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function act<T>(kind: typeof busy.value, fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = kind;
  error.value = "";
  notice.value = "";
  try {
    return await fn();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = "";
  }
}

async function select(mail: MailSummary) {
  selected.value = mail;
  article.value = null;
  original.value = null;
  images.value = null;
  notice.value = "";
  // Auf schmalen Bildschirmen steht der Inhalt unter der Liste – dorthin springen
  if (!window.matchMedia("(min-width: 1024px)").matches) {
    nextTick(() => detail.value?.scrollIntoView({ behavior: "smooth" }));
  }
  // Original parallel laden – wird für die Vergleichsansicht gebraucht
  api.original(mail.uid).then((o) => {
    if (selected.value?.uid === mail.uid) original.value = o;
  }).catch(() => undefined);
  // Bilder ebenfalls parallel – beim ersten Mal werden verlinkte Bilder heruntergeladen
  api.images(mail.uid).then((r) => {
    if (selected.value?.uid === mail.uid) images.value = r;
  }).catch(() => (images.value = { images: [], downloadLinks: [] }));
  if (mail.hasDraft) await preview(false);
}

async function preview(refresh: boolean) {
  if (!selected.value) return;
  const uid = selected.value.uid;
  const result = await act("preview", () => api.preview(uid, refresh));
  if (result && selected.value?.uid === uid) {
    article.value = result;
    selected.value.hasDraft = true;
  }
}

async function save(edited: Article) {
  if (!selected.value) return;
  const uid = selected.value.uid;
  const result = await act("save", () => api.saveDraft(uid, edited));
  if (result) {
    article.value = result;
    notice.value = "Gespeichert";
  }
}

async function publish() {
  if (!selected.value) return;
  const uid = selected.value.uid;
  const post = await act("publish", () => api.publish(uid));
  if (post) {
    removeSelected();
    notice.value = `Veröffentlicht: ${post.link}`;
  }
}

async function skip() {
  if (!selected.value) return;
  const uid = selected.value.uid;
  if (await act("skip", () => api.skip(uid))) removeSelected();
}

function removeSelected() {
  mails.value = mails.value.filter((m) => m.uid !== selected.value?.uid);
  selected.value = null;
  article.value = null;
  original.value = null;
  images.value = null;
  emit("changed");
}

// Hat der Zeitplan für die geöffnete Mail gerade einen Entwurf fertig geschrieben → anzeigen
watch(() => (selected.value ? live.finished[selected.value.uid] : 0), (n) => {
  if (n && selected.value && busy.value !== "preview") {
    selected.value.hasDraft = true;
    preview(false);
  }
});

onMounted(load);
</script>

<template>
  <p v-if="error" class="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">{{ error }}</p>
  <p v-if="notice" class="mb-4 truncate text-sm text-emerald-700 dark:text-emerald-400">{{ notice }}</p>

  <div class="grid gap-8 lg:grid-cols-[20rem_1fr]">
    <!-- Liste -->
    <section class="min-w-0">
      <div class="mb-2 flex items-center gap-3">
        <button
          v-for="[id, label] in ([['all', `Alle · ${mails.length}`], ['drafts', `Vorschläge · ${draftCount}`]] as const)"
          :key="id"
          class="eyebrow transition-colors"
          :class="filter === id ? '!text-zinc-900 dark:!text-white' : 'hover:!text-zinc-600 dark:hover:!text-zinc-300'"
          @click="filter = id"
        >
          {{ label }}
        </button>
        <button class="btn -mr-3 ml-auto h-7 text-xs" :disabled="loading" @click="load">Neu laden</button>
      </div>

      <p v-if="loading" class="py-6 text-sm text-zinc-500">Postfach wird gelesen …</p>
      <p v-else-if="!visible.length" class="py-6 text-sm text-zinc-500">{{ filter === "drafts" ? "Noch keine Vorschläge." : "Keine neuen Mails." }}</p>
      <ul v-else class="-mx-2 max-h-[75vh] overflow-y-auto">
        <li v-for="m in visible" :key="m.uid">
          <button
            class="w-full rounded-md px-2 py-2.5 text-left transition-colors"
            :class="selected?.uid === m.uid ? 'bg-zinc-100 dark:bg-zinc-900' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50'"
            @click="select(m)"
          >
            <div class="flex items-baseline gap-2">
              <span class="truncate text-sm" :class="m.prefilter ? 'font-medium' : 'text-zinc-400'">{{ m.subject || "(kein Betreff)" }}</span>
              <span v-if="m.hasDraft" class="ml-auto size-1.5 shrink-0 rounded-full bg-emerald-500" title="Entwurf vorhanden" />
            </div>
            <div class="mt-0.5 flex gap-2 text-xs text-zinc-500">
              <span class="truncate">{{ m.sender.replace(/<.*>/, "").trim() || m.sender }}</span>
              <span class="ml-auto shrink-0 tabular-nums">{{ formatDate(m.date) }}</span>
            </div>
          </button>
        </li>
      </ul>
    </section>

    <!-- Detail -->
    <section ref="detail" class="min-w-0 scroll-mt-4">
      <div v-if="!selected" class="hidden h-64 items-center lg:flex justify-center rounded-lg border border-dashed border-zinc-200 text-sm text-zinc-400 dark:border-zinc-800">
        Mail auswählen
      </div>

      <template v-else>
        <div class="mb-6 flex flex-wrap items-start gap-4">
          <div class="mr-auto min-w-0">
            <h2 class="text-base font-semibold leading-snug">{{ selected.subject }}</h2>
            <p class="mt-0.5 text-xs text-zinc-500">{{ selected.sender }} · {{ formatDate(selected.date) }}</p>
          </div>
          <div class="flex gap-1">
            <button class="btn btn-danger" :disabled="!!busy" @click="skip">Überspringen</button>
            <button class="btn" :class="!article && 'btn-primary'" :disabled="!!busy" @click="preview(!!article)">
              {{ busy === "preview" ? "Wird geschrieben …" : article ? "Neu generieren" : "Beitrag generieren" }}
            </button>
          </div>
        </div>

        <LiveOutput v-if="liveRun" :run="liveRun" />
        <div v-else-if="busy === 'preview'" class="space-y-3">
          <div v-for="w in ['w-2/3', 'w-full', 'w-5/6', 'w-full', 'w-3/4']" :key="w" class="h-3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" :class="w" />
        </div>

        <ArticleEditor
          v-else-if="article"
          :article="article"
          :original="original"
          :images="images"
          :uid="selected.uid"
          :categories="status?.config.categories ?? []"
          :busy="busy"
          :limit-reached="limitReached"
          @save="save"
          @publish="publish"
        />

        <div v-else class="whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          {{ original?.body ?? selected.snippet + " …" }}
        </div>
      </template>
    </section>
  </div>
</template>
