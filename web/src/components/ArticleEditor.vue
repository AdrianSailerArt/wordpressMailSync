<script setup lang="ts">
import { computed, ref, toRaw, watch } from "vue";
import { api, type Article, type MailImages, type OriginalMail, type WpCategories, type WpCategory } from "../api";
import Icon from "./Icon.vue";
import MailCompare from "./MailCompare.vue";
import MailView from "./MailView.vue";
import TraceView from "./TraceView.vue";

const props = defineProps<{
  article: Article;
  original: OriginalMail | null;
  images: MailImages | null;
  uid: number;
  categories: string[];
  busy: string;
}>();
const emit = defineEmits<{ save: [Article]; publish: [] }>();

type View = "preview" | "original" | "compare" | "trace" | "html";
const views: { id: View; label: string }[] = [
  { id: "preview", label: "Beitrag" },
  { id: "original", label: "Original" },
  { id: "compare", label: "Vergleich" },
  { id: "trace", label: "KI" },
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

// Kategorien kommen aus WordPress; ohne Verbindung (Demo) bleibt die Auswahl aus WP_CATEGORIES
const wp = ref<WpCategories | null>(null);
const wpError = ref("");
api.wpCategories().then((r) => (wp.value = r)).catch((err) => (wpError.value = String(err.message ?? err)));

/** Hauptkategorien mit ihren Unterkategorien, z. B. Musik › News, Reviews … */
const categoryTree = computed(() => {
  const list = wp.value?.categories ?? [];
  // tiefere Ebenen mit Pfad, z. B. Media › „Comics / Graphic Novels › News“
  const below = (id: number, prefix: string): { c: WpCategory; name: string }[] =>
    list.filter((c) => c.parent === id).flatMap((c) => [{ c, name: prefix + c.name }, ...below(c.id, `${prefix}${c.name} › `)]);
  return list.filter((c) => !c.parent || !list.some((p) => p.id === c.parent))
    .map((top) => ({ top, children: below(top.id, "") }));
});

/** Gewählte Slugs: ohne eigene Auswahl die Kategorie des Modells */
const selectedCategories = computed<string[]>(() => {
  if (draft.value.wp_categories?.length) return draft.value.wp_categories;
  const slug = wp.value?.defaults[draft.value.category] ?? draft.value.category;
  return wp.value?.categories.some((c) => c.slug === slug) ? [slug] : [];
});

function toggleCategory(slug: string) {
  const list = selectedCategories.value;
  draft.value.wp_categories = list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug];
}

const categoryLabel = computed(() => {
  const list = wp.value?.categories ?? [];
  return selectedCategories.value.map((slug) => {
    const c = list.find((x) => x.slug === slug);
    if (!c) return slug;
    const path = [c.name];
    for (let p = list.find((x) => x.id === c.parent); p; p = list.find((x) => x.id === p!.parent)) path.unshift(p.name);
    return path.join(" › ");
  }).join(", ");
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

/** Gewählte Videos: ohne eigene Auswahl automatisch das erste Video der Mail */
const selectedVideos = computed(() => draft.value.videos ?? props.images?.videos.slice(0, 1).map((v) => v.id) ?? []);

function toggleVideo(id: string) {
  const list = selectedVideos.value;
  draft.value.videos = list.includes(id) ? list.filter((v) => v !== id) : [...list, id];
}

const kb = (bytes: number) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);

const hint = (ok: boolean) => (ok ? "text-zinc-400 tabular-nums" : "text-amber-600 tabular-nums dark:text-amber-400");
</script>

<template>
  <div v-if="!article.relevant" class="space-y-4">
    <div class="alert alert-warn">
      <Icon name="alert" class="mt-0.5" />
      <div>
        <p class="font-medium">Keine Musik-Pressemitteilung</p>
        <p class="mt-0.5 opacity-80">{{ article.reason }}</p>
      </div>
    </div>
    <details class="group">
      <summary class="cursor-pointer text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">KI-Protokoll ansehen</summary>
      <TraceView class="mt-3" :uid="uid" />
    </details>
  </div>

  <div v-else class="space-y-8">
    <!-- Titel & Kerndaten -->
    <section class="space-y-4">
      <div>
        <label class="label">Titel <span :class="hint(titleLen <= 90)">{{ titleLen }}/90</span></label>
        <input v-model="draft.title" class="field !py-2.5 text-base font-semibold" />
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        <div>
          <label class="label">SEO-Titel <span :class="hint(seoLen > 0 && seoLen <= 60)">{{ seoLen }}/60</span></label>
          <input v-model="draft.seo_title" class="field" />
        </div>
        <div>
          <label class="label">Fokus-Keyword</label>
          <input v-model="draft.focus_keyword" class="field" />
        </div>
      </div>
      <div>
        <label class="label">Meta-Description <span :class="hint(metaLen >= 120 && metaLen <= 155)">{{ metaLen }}/155</span></label>
        <textarea v-model="draft.meta_description" rows="2" class="field resize-none" />
      </div>

      <button class="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" @click="showMeta = !showMeta">
        <Icon name="chevron" :size="14" class="transition-transform" :class="showMeta && 'rotate-90'" />
        Slug, Kategorie, Tags, Auszug
        <span v-if="categoryLabel" class="font-normal text-zinc-400">· {{ categoryLabel }}</span>
      </button>
      <div v-if="showMeta" class="grid gap-4 border border-zinc-950/30 bg-zinc-950/[0.02] p-4 sm:grid-cols-2 dark:border-white/20 dark:bg-white/[0.02]">
        <div><label class="label">Slug</label><input v-model="draft.slug" class="field font-mono text-xs" /></div>
        <div v-if="!wp">
          <label class="label">Kategorie <span v-if="wpError" class="font-normal text-zinc-400">WordPress nicht erreichbar</span></label>
          <select v-model="draft.category" class="field">
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div v-else class="sm:col-span-2">
          <label class="label">Kategorien <span class="font-normal text-zinc-400">aus WordPress · mehrere möglich</span></label>
          <div class="grid gap-3 sm:grid-cols-2">
            <div v-for="{ top, children } in categoryTree" :key="top.id">
              <div class="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  class="cat-chip font-semibold"
                  :class="selectedCategories.includes(top.slug) && 'cat-chip-on'"
                  @click="toggleCategory(top.slug)"
                >{{ top.name }}</button>
                <button
                  v-for="{ c, name } in children"
                  :key="c.id"
                  type="button"
                  class="cat-chip"
                  :class="selectedCategories.includes(c.slug) && 'cat-chip-on'"
                  :title="`${top.name} › ${name} · ${c.count} Beiträge`"
                  @click="toggleCategory(c.slug)"
                >{{ name }}</button>
              </div>
            </div>
          </div>
          <p v-if="!selectedCategories.length" class="mt-2 text-xs text-amber-600">Keine Kategorie gewählt – WordPress nimmt dann „{{ draft.category }}“.</p>
        </div>
        <div class="sm:col-span-2"><label class="label">Tags <span class="font-normal text-zinc-400">mit Komma trennen</span></label><input v-model="tagsText" class="field" /></div>
        <div class="sm:col-span-2"><label class="label">Auszug</label><textarea v-model="draft.excerpt" rows="2" class="field resize-none" /></div>
        <div v-if="draft.image_credit" class="sm:col-span-2"><label class="label">Fotocredit</label><input v-model="draft.image_credit" class="field" /></div>
      </div>
    </section>

    <!-- Bilder -->
    <section>
      <div class="mb-3 flex items-center gap-2">
        <Icon name="image" class="text-zinc-400" />
        <h3 class="text-sm font-semibold">Bilder</h3>
        <span v-if="images?.images.length" class="text-xs text-zinc-500">Klick = Beitragsbild · „+ Text“ = zusätzlich im Text</span>
        <button
          v-if="images?.images.length"
          class="btn btn-sm ml-auto"
          :class="thumbnailId === null && '!ring-brand-500 text-brand-700 dark:text-brand-300'"
          @click="setThumbnail(thumbnailId === null ? '' : 'none')"
        >
          <Icon v-if="thumbnailId === null" name="check" :size="13" />ohne Beitragsbild
        </button>
      </div>

      <div v-if="!images" class="grid grid-cols-3 gap-3 sm:grid-cols-5"><div v-for="n in 5" :key="n" class="skeleton aspect-square rounded-lg" /></div>
      <p v-else-if="!images.images.length" class="text-sm text-zinc-500">Keine brauchbaren Bilder in der Mail gefunden.</p>
      <div v-else class="grid grid-cols-3 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        <figure v-for="img in images.images" :key="img.id" class="group relative">
          <button
            class="block aspect-square w-full overflow-hidden rounded-lg bg-zinc-100 ring-offset-2 ring-offset-white transition dark:bg-zinc-800 dark:ring-offset-zinc-900"
            :class="thumbnailId === img.id ? 'ring-2 ring-brand-600 dark:ring-brand-400' : 'opacity-85 ring-1 ring-zinc-950/40 hover:opacity-100 dark:ring-white/10'"
            :title="`Als Beitragsbild verwenden – ${img.width}×${img.height}, ${kb(img.bytes)}`"
            @click="setThumbnail(img.id)"
          >
            <img :src="api.imageUrl(uid, img.id)" :alt="img.filename" loading="lazy" class="size-full object-cover transition group-hover:scale-[1.03]" />
          </button>
          <span v-if="thumbnailId === img.id" class="absolute top-1.5 left-1.5 rounded-md bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">Beitragsbild</span>
          <button
            class="absolute top-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold shadow transition"
            :class="draft.inline_images.includes(img.id) ? 'bg-emerald-600 text-white' : 'bg-white/90 text-zinc-700 opacity-0 group-hover:opacity-100 focus:opacity-100 dark:bg-zinc-900/90 dark:text-zinc-200'"
            title="Zusätzlich im Text nach der Einleitung einfügen"
            @click="toggleInline(img.id)"
          >
            {{ draft.inline_images.includes(img.id) ? "✓ im Text" : "+ Text" }}
          </button>
          <figcaption class="mt-1 truncate text-[11px] tabular-nums text-zinc-400">{{ img.width }}×{{ img.height }} · {{ img.origin }}</figcaption>
        </figure>
      </div>

      <div v-if="images?.videos.length" class="mt-6">
        <div class="label"><span>Videos</span><span class="font-normal text-zinc-400">cookiefrei: eigenes Vorschaubild mit Link zu YouTube</span></div>
        <div class="grid gap-3 sm:grid-cols-2">
          <button
            v-for="v in images.videos"
            :key="v.id"
            class="flex items-center gap-3 rounded-xl p-2 text-left ring-1 transition"
            :class="selectedVideos.includes(v.id) ? 'ring-2 ring-brand-600 dark:ring-brand-400' : 'ring-zinc-950/10 opacity-75 hover:opacity-100 dark:ring-white/10'"
            @click="toggleVideo(v.id)"
          >
            <span class="relative block aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
              <img :src="`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`" :alt="v.title" loading="lazy" class="size-full object-cover" />
              <span class="absolute inset-0 flex items-center justify-center text-white drop-shadow"><Icon name="play" :size="20" /></span>
            </span>
            <span class="min-w-0 flex-1">
              <span class="line-clamp-2 text-sm font-medium">{{ v.title || v.id }}</span>
              <span class="block truncate text-xs text-zinc-500">{{ v.channel }}</span>
              <span class="mt-1 inline-flex" :class="selectedVideos.includes(v.id) ? 'badge badge-green' : 'badge'">
                {{ selectedVideos.includes(v.id) ? "im Beitrag" : "nicht im Beitrag" }}
              </span>
            </span>
          </button>
        </div>
      </div>

      <ul v-if="images?.downloadLinks.length" class="mt-4 space-y-1 text-xs">
        <li v-for="l in images.downloadLinks" :key="l.url" class="flex items-center gap-1.5 truncate">
          <Icon name="download" :size="13" class="text-zinc-400" />
          <span class="text-zinc-500">Nur für dich, nicht im Artikel – Pressefotos:</span>
          <a :href="l.url" target="_blank" rel="noopener" class="truncate font-medium underline underline-offset-2">{{ l.label }}</a>
        </li>
      </ul>
    </section>

    <!-- Ansicht -->
    <section class="overflow-hidden rounded-xl ring-1 ring-zinc-950/40 dark:ring-white/20">
      <div class="tabs bg-zinc-950/[0.02] dark:bg-white/[0.02]" role="tablist">
        <button v-for="v in views" :key="v.id" role="tab" :aria-selected="view === v.id" @click="view = v.id">
          {{ v.label }}
        </button>
      </div>

      <div class="p-4 sm:p-5">
        <article v-if="view === 'preview'" class="prose prose-zinc mx-auto max-w-3xl dark:prose-invert prose-headings:font-semibold prose-h2:text-lg prose-a:text-brand-700 dark:prose-a:text-brand-300">
          <h1 class="!text-2xl">{{ draft.title }}</h1>
          <div v-html="draft.content_html" />
        </article>

        <template v-else-if="view === 'original' || view === 'compare'">
          <div v-if="!original" class="space-y-3"><div v-for="n in 4" :key="n" class="skeleton h-3" /></div>
          <MailView v-else-if="view === 'original'" :uid="uid" :original="original" :article="draft" />
          <MailCompare v-else :original="original.body" :html="draft.content_html" :title="draft.title" />
        </template>

        <TraceView v-else-if="view === 'trace'" :uid="uid" />

        <textarea v-else v-model="draft.content_html" rows="24" class="field font-mono text-xs leading-relaxed" />
      </div>
    </section>

    <!-- Aktionen -->
    <div class="sticky bottom-20 z-10 -mx-1 flex flex-wrap items-center gap-2 border border-zinc-950 bg-white px-3 py-2.5 shadow-md lg:bottom-4 dark:border-white/40 dark:bg-zinc-900 dark:shadow-none">
      <span class="mr-auto flex items-center gap-1.5 text-xs" :class="dirty ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'">
        <span v-if="dirty" class="size-1.5 rounded-full bg-amber-500" />
        {{ dirty ? "Ungespeicherte Änderungen" : article.generated_by ? `geschrieben von ${article.generated_by}` : "" }}
      </span>
      <button class="btn" :disabled="!dirty || !!busy" @click="emit('save', { ...draft, tags: tags() })">
        <Icon name="save" />{{ busy === "save" ? "Speichert …" : "Speichern" }}
      </button>
      <button class="btn btn-primary" :disabled="dirty || !!busy" :title="dirty ? 'Erst speichern' : 'In WordPress veröffentlichen'" @click="emit('publish')">
        <Icon name="send" />{{ busy === "publish" ? "Veröffentlicht …" : "Veröffentlichen" }}
      </button>
    </div>
  </div>
</template>
