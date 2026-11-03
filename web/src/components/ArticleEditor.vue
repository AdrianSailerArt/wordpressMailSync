<script setup lang="ts">
import { computed, ref, toRaw, watch } from "vue";
import type { Article, OriginalMail } from "../api";
import MailCompare from "./MailCompare.vue";

const props = defineProps<{
  article: Article;
  original: OriginalMail | null;
  categories: string[];
  busy: string;
  limitReached: boolean;
}>();
const emit = defineEmits<{ save: [Article]; publish: [] }>();

type View = "preview" | "original" | "compare" | "html";
const views: { id: View; label: string }[] = [
  { id: "preview", label: "Beitrag" },
  { id: "original", label: "Original" },
  { id: "compare", label: "Vergleich" },
  { id: "html", label: "HTML" },
];

const draft = ref<Article>(structuredClone(toRaw(props.article)));
const tagsText = ref(props.article.tags.join(", "));
// Direkt nach dem Generieren den Vergleich zeigen, damit Fakten geprüft werden
const view = ref<View>("compare");
const showMeta = ref(false);

watch(() => props.article, (a) => {
  draft.value = structuredClone(toRaw(a));
  tagsText.value = a.tags.join(", ");
});

const tags = () => tagsText.value.split(",").map((t) => t.trim()).filter(Boolean);
const dirty = computed(() => JSON.stringify({ ...draft.value, tags: tags() }) !== JSON.stringify(props.article));
const titleLen = computed(() => draft.value.title.length);
const metaLen = computed(() => draft.value.meta_description.length);

const hint = (ok: boolean) => (ok ? "text-zinc-400" : "text-amber-600 dark:text-amber-400");
</script>

<template>
  <div v-if="!article.relevant" class="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
    <p class="font-medium">Keine Musik-Pressemitteilung</p>
    <p class="mt-1 text-zinc-500">{{ article.reason }}</p>
  </div>

  <div v-else class="space-y-6">
    <!-- Titel & Kerndaten -->
    <div class="space-y-4">
      <div>
        <label class="label">Titel <span :class="hint(titleLen <= 60)">{{ titleLen }}/60</span></label>
        <input v-model="draft.title" class="field text-base font-medium" />
      </div>
      <div>
        <label class="label">Meta-Description <span :class="hint(metaLen >= 120 && metaLen <= 155)">{{ metaLen }}/155</span></label>
        <textarea v-model="draft.meta_description" rows="2" class="field resize-none" />
      </div>

      <button class="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" @click="showMeta = !showMeta">
        {{ showMeta ? "−" : "+" }} Keyword, Slug, Kategorie, Tags
      </button>
      <div v-if="showMeta" class="grid gap-4 sm:grid-cols-2">
        <div><label class="label">Fokus-Keyword</label><input v-model="draft.focus_keyword" class="field" /></div>
        <div><label class="label">Slug</label><input v-model="draft.slug" class="field font-mono text-xs" /></div>
        <div>
          <label class="label">Kategorie</label>
          <select v-model="draft.category" class="field">
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div><label class="label">Tags</label><input v-model="tagsText" class="field" /></div>
        <div class="sm:col-span-2"><label class="label">Auszug</label><textarea v-model="draft.excerpt" rows="2" class="field resize-none" /></div>
        <div v-if="draft.image_credit" class="sm:col-span-2"><label class="label">Fotocredit</label><input v-model="draft.image_credit" class="field" /></div>
      </div>
    </div>

    <!-- Ansicht -->
    <div>
      <div class="mb-4 flex gap-4 border-b border-zinc-200 text-sm dark:border-zinc-800">
        <button
          v-for="v in views"
          :key="v.id"
          class="-mb-px border-b pb-2 transition-colors"
          :class="view === v.id ? 'border-zinc-900 text-zinc-900 dark:border-white dark:text-white' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'"
          @click="view = v.id"
        >
          {{ v.label }}
        </button>
      </div>

      <article v-if="view === 'preview'" class="prose prose-zinc max-w-none dark:prose-invert prose-headings:font-semibold prose-h2:text-lg">
        <h1 class="!text-2xl">{{ draft.title }}</h1>
        <div v-html="draft.content_html" />
      </article>

      <template v-else-if="view === 'original' || view === 'compare'">
        <p v-if="!original" class="text-sm text-zinc-500">Original wird geladen …</p>
        <div v-else-if="view === 'original'" class="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{{ original.body }}</div>
        <MailCompare v-else :original="original.body" :html="draft.content_html" :title="draft.title" />
      </template>

      <textarea v-else v-model="draft.content_html" rows="24" class="field font-mono text-xs leading-relaxed" />
    </div>

    <!-- Aktionen -->
    <div class="sticky bottom-0 -mx-1 flex items-center gap-2 bg-white/90 px-1 py-3 backdrop-blur dark:bg-zinc-950/90">
      <span class="mr-auto text-xs text-zinc-500">
        {{ dirty ? "Ungespeicherte Änderungen" : limitReached ? "Tageslimit erreicht" : "" }}
      </span>
      <button class="btn" :disabled="!dirty || !!busy" @click="emit('save', { ...draft, tags: tags() })">
        {{ busy === "save" ? "Speichert …" : "Speichern" }}
      </button>
      <button class="btn btn-primary" :disabled="dirty || !!busy || limitReached" @click="emit('publish')">
        {{ busy === "publish" ? "Veröffentlicht …" : "Veröffentlichen" }}
      </button>
    </div>
  </div>
</template>
