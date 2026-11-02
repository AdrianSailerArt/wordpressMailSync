<script setup lang="ts">
import { computed, ref, toRaw, watch } from "vue";
import type { Article } from "../api";

const props = defineProps<{ article: Article; categories: string[]; busy: string; limitReached: boolean }>();
const emit = defineEmits<{ save: [Article]; publish: [] }>();

const draft = ref<Article>(structuredClone(toRaw(props.article)));
const tagsText = ref(props.article.tags.join(", "));
const mode = ref<"preview" | "html">("preview");

watch(() => props.article, (a) => {
  draft.value = structuredClone(toRaw(a));
  tagsText.value = a.tags.join(", ");
});

const dirty = computed(() =>
  JSON.stringify({ ...draft.value, tags: tagsText.value.split(",").map((t) => t.trim()).filter(Boolean) }) !==
  JSON.stringify(props.article));

const titleLen = computed(() => draft.value.title.length);
const metaLen = computed(() => draft.value.meta_description.length);

function save() {
  emit("save", { ...draft.value, tags: tagsText.value.split(",").map((t) => t.trim()).filter(Boolean) });
}
</script>

<template>
  <div v-if="!article.relevant" class="card">
    <strong>Claude hält diese Mail nicht für eine Musik-Pressemitteilung.</strong>
    <p class="muted">{{ article.reason }}</p>
  </div>

  <div v-else class="card editor">
    <div class="grid">
      <div class="full">
        <label>SEO-Titel <span :class="['badge', titleLen > 60 ? 'warn' : 'ok']">{{ titleLen }}/60</span></label>
        <input v-model="draft.title" />
      </div>
      <div class="full">
        <label>Meta-Description <span :class="['badge', metaLen > 155 || metaLen < 120 ? 'warn' : 'ok']">{{ metaLen }}/155</span></label>
        <textarea v-model="draft.meta_description" rows="2" />
      </div>
      <div>
        <label>Fokus-Keyword</label>
        <input v-model="draft.focus_keyword" />
      </div>
      <div>
        <label>Slug</label>
        <input v-model="draft.slug" />
      </div>
      <div>
        <label>Kategorie</label>
        <select v-model="draft.category">
          <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div>
        <label>Tags (kommagetrennt)</label>
        <input v-model="tagsText" />
      </div>
      <div class="full">
        <label>Auszug</label>
        <textarea v-model="draft.excerpt" rows="2" />
      </div>
      <div v-if="draft.image_credit" class="full">
        <label>Fotocredit</label>
        <input v-model="draft.image_credit" />
      </div>
    </div>

    <div class="row mode">
      <button :class="{ on: mode === 'preview' }" @click="mode = 'preview'">Vorschau</button>
      <button :class="{ on: mode === 'html' }" @click="mode = 'html'">HTML bearbeiten</button>
    </div>
    <article v-if="mode === 'preview'" class="content">
      <h1>{{ draft.title }}</h1>
      <div v-html="draft.content_html" />
    </article>
    <textarea v-else v-model="draft.content_html" class="code" rows="22" />

    <div class="row actions">
      <button :disabled="!dirty || !!busy" @click="save">{{ busy === "save" ? "Speichert …" : "Änderungen speichern" }}</button>
      <button class="primary" :disabled="dirty || !!busy || limitReached" @click="emit('publish')">
        {{ busy === "publish" ? "Veröffentlicht …" : "In WordPress veröffentlichen" }}
      </button>
      <span v-if="dirty" class="muted small">Erst speichern, dann veröffentlichen.</span>
      <span v-else-if="limitReached" class="muted small">Tageslimit erreicht.</span>
    </div>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.full { grid-column: 1 / -1; }
.mode { margin: 18px 0 10px; gap: 4px; }
.mode button.on { background: var(--surface-2); font-weight: 600; }
.content { border: 1px solid var(--border); border-radius: 8px; padding: 4px 20px 12px; max-height: 60vh; overflow: auto; }
.content h1 { font-size: 24px; }
.content :deep(h2) { font-size: 19px; margin-top: 1.4em; }
.actions { margin-top: 14px; }
.small { font-size: 12px; }
@media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
