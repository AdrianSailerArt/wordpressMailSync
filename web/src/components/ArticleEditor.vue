<script setup lang="ts">
import { computed, ref, toRaw, watch } from "vue";
import { api, type Article, type MailImages, type OriginalMail } from "../api";
import MailCompare from "./MailCompare.vue";

const props = defineProps<{
  article: Article;
  original: OriginalMail | null;
  images: MailImages | null;
  uid: number;
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
const seoLen = computed(() => draft.value.seo_title.length);

/** Aktuelles Thumbnail: Auswahl im Entwurf, sonst automatisch das größte Bild */
const thumbnailId = computed(() =>
  draft.value.featured_image === "none" ? null : draft.value.featured_image || props.images?.images[0]?.id || null);

function setThumbnail(id: string | "none") {
  // das automatisch gewählte größte Bild als "" speichern, damit es Standard bleibt
  draft.value.featured_image = id === props.images?.images[0]?.id ? "" : id;
}

function toggleInline(id: string) {
  const list = draft.value.inline_images;
  draft.value.inline_images = list.includes(id) ? list.filter((i) => i !== id) : [...list, id];
}

const kb = (bytes: number) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);

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
        <label class="label">Titel <span :class="hint(titleLen <= 90)">{{ titleLen }}/90</span></label>
        <input v-model="draft.title" class="field text-base font-medium" />
      </div>
      <div>
        <label class="label">SEO-Titel <span :class="hint(seoLen > 0 && seoLen <= 60)">{{ seoLen }}/60</span></label>
        <input v-model="draft.seo_title" class="field" />
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

    <!-- Bilder -->
    <div>
      <div class="label">
        <span>Bilder</span>
        <button
          v-if="images?.images.length"
          class="hover:text-zinc-800 dark:hover:text-zinc-200"
          :class="thumbnailId === null && 'text-zinc-900 dark:text-white'"
          @click="setThumbnail(thumbnailId === null ? '' : 'none')"
        >
          {{ thumbnailId === null ? "✓ ohne Beitragsbild" : "ohne Beitragsbild" }}
        </button>
      </div>

      <p v-if="!images" class="text-sm text-zinc-500">Bilder werden geladen …</p>
      <p v-else-if="!images.images.length" class="text-sm text-zinc-500">Keine brauchbaren Bilder in der Mail gefunden.</p>
      <div v-else class="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        <figure v-for="img in images.images" :key="img.id" class="group relative">
          <button
            class="block aspect-square w-full overflow-hidden rounded-md bg-zinc-100 ring-offset-2 transition dark:bg-zinc-900 dark:ring-offset-zinc-950"
            :class="thumbnailId === img.id ? 'ring-2 ring-zinc-900 dark:ring-white' : 'opacity-80 hover:opacity-100'"
            :title="`Als Thumbnail verwenden – ${img.width}×${img.height}, ${kb(img.bytes)}`"
            @click="setThumbnail(img.id)"
          >
            <img :src="api.imageUrl(uid, img.id)" :alt="img.filename" loading="lazy" class="size-full object-cover" />
          </button>
          <span v-if="thumbnailId === img.id" class="absolute left-1.5 top-1.5 rounded bg-zinc-900/80 px-1.5 py-0.5 text-[10px] font-medium text-white">Thumbnail</span>
          <button
            class="absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition"
            :class="draft.inline_images.includes(img.id) ? 'bg-emerald-600 text-white' : 'bg-white/85 text-zinc-700 opacity-0 group-hover:opacity-100 dark:bg-zinc-900/85 dark:text-zinc-200'"
            title="Zusätzlich im Text nach der Einleitung einfügen"
            @click="toggleInline(img.id)"
          >
            {{ draft.inline_images.includes(img.id) ? "✓ im Text" : "+ Text" }}
          </button>
          <figcaption class="mt-1 truncate text-[11px] tabular-nums text-zinc-400">{{ img.width }}×{{ img.height }} · {{ img.origin }}</figcaption>
        </figure>
      </div>

      <ul v-if="images?.downloadLinks.length" class="mt-3 space-y-1 text-xs">
        <li v-for="l in images.downloadLinks" :key="l.url" class="truncate">
          <span class="text-zinc-500">Pressefotos: </span>
          <a :href="l.url" target="_blank" rel="noopener" class="underline underline-offset-2">{{ l.label }}</a>
        </li>
      </ul>
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
