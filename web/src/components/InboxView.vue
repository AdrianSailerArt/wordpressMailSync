<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { api, formatDate, type Article, type MailboxStatus, type MailImages, type MailSummary, type OriginalMail, type Status } from "../api";
import { live } from "../llm";
import ArticleEditor from "./ArticleEditor.vue";
import LiveOutput from "./LiveOutput.vue";
import Icon from "./Icon.vue";
import MailView from "./MailView.vue";

const props = defineProps<{ status: Status | null; openUid?: number | null }>();
const emit = defineEmits<{ changed: []; opened: [] }>();

const mails = ref<MailSummary[]>([]);
const mailboxes = ref<MailboxStatus[]>([]);
/** Postfach-Kennung nur zeigen, wenn es mehrere gibt */
const multi = computed(() => mailboxes.value.length > 1);
const failed = computed(() => mailboxes.value.filter((m) => m.error));
const duplicateCount = computed(() => mails.value.reduce((n, m) => n + m.duplicates.length, 0));
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
    ({ mails: mails.value, mailboxes: mailboxes.value } = await api.mails());
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
  if (!window.matchMedia("(min-width: 1280px)").matches) {
    nextTick(() => detail.value?.scrollIntoView({ behavior: "smooth" }));
  }
  // Original parallel laden – wird für die Vergleichsansicht gebraucht
  api.original(mail.uid).then((o) => {
    if (selected.value?.uid === mail.uid) original.value = o;
  }).catch(() => undefined);
  // Bilder ebenfalls parallel – beim ersten Mal werden verlinkte Bilder heruntergeladen
  api.images(mail.uid).then((r) => {
    if (selected.value?.uid === mail.uid) images.value = r;
  }).catch(() => (images.value = { images: [], downloadLinks: [], videos: [] }));
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
  <div v-if="error" class="alert alert-error mb-4"><Icon name="alert" class="mt-0.5" /><span class="min-w-0 break-words">{{ error }}</span></div>
  <div v-if="notice" class="alert alert-ok mb-4"><Icon name="check" class="mt-0.5" /><span class="min-w-0 truncate">{{ notice }}</span></div>

  <div class="grid items-start gap-6 xl:grid-cols-[20rem_minmax(0,1fr)] 2xl:grid-cols-[24rem_minmax(0,1fr)]">
    <!-- Liste -->
    <section class="card min-w-0 overflow-hidden xl:sticky xl:top-6">
      <div class="card-header">
        <div class="segmented">
          <button
            v-for="[id, label, n] in ([['all', 'Alle', mails.length], ['drafts', 'Vorschläge', draftCount]] as const)"
            :key="id"
            :aria-pressed="filter === id"
            @click="filter = id"
          >
            {{ label }} <span class="ml-0.5 tabular-nums opacity-60">{{ n }}</span>
          </button>
        </div>
        <button class="btn btn-ghost btn-sm ml-auto" :disabled="loading" title="Postfach neu lesen" @click="load">
          <Icon name="refresh" :size="14" :class="loading && 'animate-spin'" />Neu laden
        </button>
      </div>

      <div v-if="failed.length || (duplicateCount && !loading)" class="space-y-2 border-b border-zinc-950/5 px-4 py-3 dark:border-white/10">
        <p v-for="f in failed" :key="f.name" class="alert alert-warn !px-2.5 !py-1.5 text-xs">
          <Icon name="alert" :size="14" class="mt-0.5" /><span><span class="font-medium">{{ f.name }}</span> nicht erreichbar: {{ f.error }}</span>
        </p>
        <p v-if="duplicateCount && !loading" class="text-xs text-zinc-500">
          <Icon name="layers" :size="13" class="mr-1 inline -translate-y-px" />{{ duplicateCount }} doppelte Mail{{ duplicateCount === 1 ? "" : "s" }} zusammengefasst
        </p>
      </div>

      <div v-if="loading" class="space-y-4 p-4">
        <div v-for="n in 6" :key="n" class="space-y-2"><div class="skeleton h-3.5 w-4/5" /><div class="skeleton h-3 w-1/2" /></div>
      </div>
      <div v-else-if="!visible.length" class="px-4 py-12 text-center text-sm text-zinc-500">
        <Icon name="inbox" :size="28" class="mx-auto mb-2 text-zinc-300 dark:text-zinc-600" />
        {{ filter === "drafts" ? "Noch keine Vorschläge." : "Keine neuen Mails." }}
      </div>
      <ul v-else class="max-h-[45vh] divide-y xl:max-h-[calc(100dvh-14rem)] divide-zinc-950/5 overflow-y-auto dark:divide-white/5">
        <li v-for="m in visible" :key="m.uid">
          <button
            class="relative w-full px-4 py-3 text-left transition-colors"
            :class="selected?.uid === m.uid ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-zinc-950/[0.025] dark:hover:bg-white/[0.03]'"
            @click="select(m)"
          >
            <span v-if="selected?.uid === m.uid" class="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand-600 dark:bg-brand-400" />
            <div class="flex items-start gap-2">
              <span class="line-clamp-2 min-w-0 flex-1 text-sm leading-snug" :class="m.prefilter ? 'font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-400'">
                {{ m.subject || "(kein Betreff)" }}
              </span>
              <span v-if="m.hasDraft" class="badge badge-green mt-0.5 shrink-0" title="Entwurf vorhanden">Entwurf</span>
            </div>
            <div class="mt-1 flex gap-2 text-xs text-zinc-500">
              <span class="truncate">{{ m.sender.replace(/<.*>/, "").trim() || m.sender }}</span>
              <span class="ml-auto shrink-0 tabular-nums">{{ formatDate(m.date) }}</span>
            </div>
            <div v-if="multi || m.duplicates.length" class="mt-1.5 flex flex-wrap gap-1">
              <span v-if="multi" class="badge truncate" :title="`Postfach: ${m.account}`">{{ m.account }}</span>
              <span
                v-if="m.duplicates.length"
                class="badge badge-sky"
                :title="`Dieselbe Mail auch in: ${m.duplicates.map((d) => d.account).join(', ')} – zusammengefasst`"
              >{{ m.duplicates.length + 1 }}× erhalten</span>
            </div>
          </button>
        </li>
      </ul>
    </section>

    <!-- Detail -->
    <section ref="detail" class="min-w-0 scroll-mt-20">
      <div v-if="!selected" class="empty hidden min-h-80 xl:flex">
        <Icon name="mail" :size="32" class="text-zinc-300 dark:text-zinc-600" />
        <p class="font-medium text-zinc-700 dark:text-zinc-300">Mail auswählen</p>
        <p class="max-w-sm">Links eine Pressemitteilung anklicken – hier siehst du das Original, den generierten Beitrag und die Prüfliste.</p>
      </div>

      <div v-else class="card">
        <div class="flex flex-wrap items-start gap-4 border-b border-zinc-950/5 p-4 sm:p-5 dark:border-white/10">
          <div class="mr-auto min-w-0">
            <h2 class="text-base leading-snug font-semibold text-zinc-950 sm:text-lg dark:text-white">{{ selected.subject }}</h2>
            <p class="mt-1 text-xs text-zinc-500">
              {{ selected.sender }} · {{ formatDate(selected.date) }}<template v-if="multi"> · {{ selected.account }}</template>
            </p>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-danger" :disabled="!!busy" title="Mail als erledigt markieren, ohne Beitrag" @click="skip">
              <Icon name="skip" />Überspringen
            </button>
            <button class="btn" :class="!article && 'btn-primary'" :disabled="!!busy" @click="preview(!!article)">
              <Icon :name="article ? 'refresh' : 'sparkles'" :class="busy === 'preview' && 'animate-pulse'" />
              {{ busy === "preview" ? "Wird geschrieben …" : article ? "Neu generieren" : "Beitrag generieren" }}
            </button>
          </div>
          <div v-if="selected.duplicates.length" class="alert alert-info w-full text-xs">
            <Icon name="layers" :size="14" class="mt-0.5" />
            <div class="min-w-0">
              <p class="font-medium">Dieselbe Mail kam {{ selected.duplicates.length + 1 }}× an – hier zusammengefasst</p>
              <ul class="mt-1 space-y-0.5 opacity-80">
                <li v-for="d in selected.duplicates" :key="d.uid" class="truncate">
                  {{ d.account || "gleiches Postfach" }} · {{ d.sender.replace(/<.*>/, "").trim() || d.sender }} · {{ formatDate(d.date) }}<template v-if="d.subject !== selected.subject"> · „{{ d.subject }}“</template>
                </li>
              </ul>
              <p class="mt-1 opacity-70">Veröffentlichen oder Überspringen erledigt alle Exemplare.</p>
            </div>
          </div>
        </div>

        <div class="p-4 sm:p-5">
          <LiveOutput v-if="liveRun" :run="liveRun" />
          <div v-else-if="busy === 'preview'" class="space-y-3">
            <div v-for="w in ['w-2/3', 'w-full', 'w-5/6', 'w-full', 'w-3/4']" :key="w" class="skeleton h-3" :class="w" />
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

          <MailView v-else :uid="selected.uid" :original="original" />
        </div>
      </div>
    </section>
  </div>
</template>
