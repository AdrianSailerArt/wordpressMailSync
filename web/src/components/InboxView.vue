<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, formatDate, type Article, type MailSummary, type Status } from "../api";
import ArticleEditor from "./ArticleEditor.vue";

const props = defineProps<{ status: Status | null }>();
const emit = defineEmits<{ changed: [] }>();

const mails = ref<MailSummary[]>([]);
const loading = ref(true);
const error = ref("");
const selected = ref<MailSummary | null>(null);
const article = ref<Article | null>(null);
const busy = ref<"" | "preview" | "publish" | "skip" | "save">("");
const notice = ref("");

const limitReached = computed(() => (props.status ? props.status.today >= props.status.limit : false));

async function load() {
  loading.value = true;
  try {
    mails.value = await api.mails();
    error.value = "";
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
    notice.value = "Entwurf gespeichert.";
  }
}

async function publish() {
  if (!selected.value) return;
  const uid = selected.value.uid;
  const post = await act("publish", () => api.publish(uid));
  if (post) {
    notice.value = `Veröffentlicht: ${post.link}`;
    removeSelected();
  }
}

async function skip() {
  if (!selected.value) return;
  const uid = selected.value.uid;
  const ok = await act("skip", () => api.skip(uid));
  if (ok) removeSelected();
}

function removeSelected() {
  mails.value = mails.value.filter((m) => m.uid !== selected.value?.uid);
  selected.value = null;
  article.value = null;
  emit("changed");
}

onMounted(load);
</script>

<template>
  <div v-if="error" class="error-box">{{ error }}</div>
  <div v-if="notice" class="card notice">{{ notice }}</div>

  <div class="layout">
    <section class="list card">
      <div class="row head">
        <strong>Unbearbeitete Mails</strong>
        <span class="badge">{{ mails.length }}</span>
        <button class="reload" :disabled="loading" @click="load">Neu laden</button>
      </div>
      <p v-if="loading" class="muted">Postfach wird gelesen …</p>
      <p v-else-if="!mails.length" class="muted">Keine neuen Mails in den letzten Tagen.</p>
      <ul v-else>
        <li v-for="m in mails" :key="m.uid" :class="{ active: selected?.uid === m.uid }" @click="select(m)">
          <div class="subject">{{ m.subject || "(kein Betreff)" }}</div>
          <div class="meta muted">{{ m.sender }} · {{ formatDate(m.date) }}</div>
          <div class="row badges">
            <span v-if="m.hasDraft" class="badge ok">Entwurf</span>
            <span v-if="!m.prefilter" class="badge warn">wohl keine Musik-News</span>
            <span v-if="m.images" class="badge">{{ m.images }} Bild{{ m.images > 1 ? "er" : "" }}</span>
          </div>
        </li>
      </ul>
    </section>

    <section class="detail">
      <div v-if="!selected" class="card empty muted">Wähle links eine Mail aus, um eine Vorschau zu erzeugen.</div>
      <template v-else>
        <div class="card mail">
          <h3>{{ selected.subject }}</h3>
          <p class="muted">{{ selected.sender }} · {{ formatDate(selected.date) }}</p>
          <p class="snippet">{{ selected.snippet }}…</p>
          <div class="row">
            <button class="primary" :disabled="!!busy" @click="preview(!!article)">
              {{ busy === "preview" ? "Claude schreibt …" : article ? "Neu generieren" : "Beitrag generieren" }}
            </button>
            <button class="danger" :disabled="!!busy" @click="skip">Überspringen</button>
          </div>
        </div>

        <ArticleEditor
          v-if="article"
          :article="article"
          :categories="status?.config.categories ?? []"
          :busy="busy"
          :limit-reached="limitReached"
          @save="save"
          @publish="publish"
        />
      </template>
    </section>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 16px; align-items: start; }
.head { margin-bottom: 8px; }
.reload { margin-left: auto; }
.list ul { list-style: none; margin: 0 -16px -16px; padding: 0; max-height: 72vh; overflow: auto; }
.list li { padding: 10px 16px; border-top: 1px solid var(--border); cursor: pointer; }
.list li:hover { background: var(--surface-2); }
.list li.active { background: var(--surface-2); box-shadow: inset 3px 0 var(--accent); }
.subject { font-weight: 600; }
.meta { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badges { margin-top: 4px; gap: 4px; }
.detail { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.mail h3 { margin: 0 0 4px; }
.snippet { white-space: pre-line; font-size: 14px; max-height: 9em; overflow: hidden; }
.empty { text-align: center; padding: 48px 16px; }
.notice { margin-bottom: 12px; color: var(--ok); overflow-wrap: anywhere; }
@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } }
</style>
