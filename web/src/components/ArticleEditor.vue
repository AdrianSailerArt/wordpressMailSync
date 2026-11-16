<script setup lang="ts">
import { computed, ref, toRaw, watch } from "vue";
import { api, type Article, type MailImages, type OriginalMail, type WpCategories, type WpCategory } from "../api";
import Icon from "./Icon.vue";
import ImageTile from "./ImageTile.vue";
import InlineImageList from "./InlineImageList.vue";
import { insertAtParagraphs, paragraphSnippets } from "../../../shared/paragraphs";
import { cachedMedia } from "../media-cache";
import MailCompare from "./MailCompare.vue";
import MailView from "./MailView.vue";
import MediaLibrary from "./MediaLibrary.vue";
import TraceView from "./TraceView.vue";

const props = defineProps<{
  article: Article;
  original: OriginalMail | null;
  images: MailImages | null;
  uid: number;
  categories: string[];
  busy: string;
}>();
const emit = defineEmits<{ save: [Article]; publish: []; images: [MailImages] }>();

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

const toggleCategory = (slug: string) => {
  const list = selectedCategories.value;
  draft.value.wp_categories = list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug];
};

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

/** Aktuelles Thumbnail: Auswahl im Entwurf, sonst automatisch das größte Bild aus der Mail */
const autoThumbnail = computed(() => props.images?.images.find((i) => i.origin !== "eigenes")?.id ?? null);
const thumbnailId = computed(() =>
  draft.value.featured_image === "none" ? null : draft.value.featured_image || autoThumbnail.value);

const setThumbnail = (id: string | "none") => {
  // immer ausdrücklich speichern – „automatisch“ hängt sonst an der Einstellung „Beitragsbild“
  draft.value.featured_image = id;
};

/** Mediathek neu befragen, sobald gespeicherte Tags oder Keyword sich ändern */
const mediaKey = computed(() => `${props.article.tags.join("|")}#${props.article.focus_keyword}`);

// ---- eigenes Bild nachträglich hinzufügen (wird gleich Beitragsbild)
const uploading = ref(false);
const uploadError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

const upload = async (files: FileList | null | undefined) => {
  const file = files?.[0];
  if (!file) return;
  uploading.value = true;
  uploadError.value = "";
  try {
    const { images, image } = await api.uploadImage(props.uid, file);
    emit("images", images);
    setThumbnail(image.id);
  } catch (e) {
    uploadError.value = (e as Error).message;
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
};

const removeImage = async (id: string) => {
  if (!confirm("Dieses hochgeladene Bild entfernen?")) return;
  try {
    const { images } = await api.removeImage(props.uid, id);
    emit("images", images);
    if (draft.value.featured_image === id) draft.value.featured_image = "";
    removeInline(id);
  } catch (e) {
    uploadError.value = (e as Error).message;
  }
};

// ---- Bilder im Text: jedes an seiner Stelle („nach Absatz n“)
const positions = computed(() => draft.value.inline_positions ?? {});

const removeInline = (id: string) => {
  draft.value.inline_images = draft.value.inline_images.filter((i) => i !== id);
  const { [id]: _, ...rest } = positions.value;
  draft.value.inline_positions = rest;
};

const moveInline = (id: string, after: number) => {
  draft.value.inline_positions = { ...positions.value, [id]: after };
};

/** Neues Bild an die erste Stelle ab Absatz 1, an der noch keins steht – so verteilen sie sich */
const freePosition = () => {
  const count = paragraphSnippets(draft.value.content_html).length;
  const taken = new Set(draft.value.inline_images.map((i) => positions.value[i] ?? 1));
  for (let p = 1; p <= count; p++) if (!taken.has(p)) return p;
  return Math.max(count, 1);
};

const toggleInline = (id: string) => {
  if (draft.value.inline_images.includes(id)) return removeInline(id);
  moveInline(id, freePosition());
  draft.value.inline_images = [...draft.value.inline_images, id];
};

/** Mediathek-Bilder erst zeigen, wenn ihre Adresse bekannt ist (lädt die Mediathek nach) */
const imageSrc = (id: string, large = false) => {
  if (!id.startsWith("wp:")) return api.imageUrl(props.uid, id);
  const media = cachedMedia(id);
  return (large ? media?.url : media?.thumb) ?? "";
};
const imageLabel = (id: string) => {
  const media = cachedMedia(id);
  if (media) return `Mediathek: ${media.title || media.filename}`;
  return props.images?.images.find((i) => i.id === id)?.filename ?? id;
};

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Vorschau mit den Textbildern an ihren Stellen (wie beim Veröffentlichen) */
const previewHtml = computed(() => insertAtParagraphs(draft.value.content_html, draft.value.inline_images
  .filter((id) => imageSrc(id, true))
  .map((id) => ({
    after: positions.value[id] ?? 1,
    html: `<figure><img src="${escapeAttr(imageSrc(id, true))}" alt="${escapeAttr(imageLabel(id))}" /></figure>`,
  }))));

/** Gewählte Videos: ohne eigene Auswahl automatisch das erste Video der Mail */
const selectedVideos = computed(() => draft.value.videos ?? props.images?.videos.slice(0, 1).map((v) => v.id) ?? []);

const toggleVideo = (id: string) => {
  const list = selectedVideos.value;
  draft.value.videos = list.includes(id) ? list.filter((v) => v !== id) : [...list, id];
};

const kb = (bytes: number) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);

const hint = (ok: boolean) => (ok ? "text-zinc-400 tabular-nums" : "text-amber-600 tabular-nums dark:text-amber-400");
</script>

<template>
  <div v-if="!article.relevant" class="space-y-4">
    <div class="alert alert-warn">
      <Icon name="alert" class="mt-0.5" />
      <div>
        <p class="font-medium">Keine News für einen Beitrag</p>
        <p class="mt-0.5 opacity-80">{{ article.reason }}</p>
      </div>
    </div>
    <details class="group">
      <summary class="cursor-pointer text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">KI-Protokoll ansehen</summary>
      <TraceView class="mt-3" :uid="uid" />
    </details>
  </div>

  <div v-else class="space-y-8">
    <!-- News ohne Musikbezug: darf veröffentlicht werden, aber nicht aus Versehen -->
    <div v-if="article.music === false" class="alert alert-warn" role="alert">
      <Icon name="alert" class="mt-0.5" />
      <div>
        <p class="font-semibold">Kein Musikbezug</p>
        <p class="mt-0.5">
          Das ist keine Musik-News<template v-if="article.music_note"> – {{ article.music_note }}</template>.
          Du kannst den Beitrag trotzdem veröffentlichen; vorher fragt Bühnenpost noch einmal nach.
        </p>
      </div>
    </div>

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

    <!-- Bilder (auch per Drag & Drop: eigenes Bild als Beitragsbild) -->
    <section
      class="relative"
      @dragover.prevent="dragging = true"
      @dragleave.self="dragging = false"
      @drop.prevent="dragging = false; upload($event.dataTransfer?.files)"
    >
      <div v-if="dragging" class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-brand-600 bg-white/85 text-sm font-semibold dark:bg-zinc-900/85">
        Bild hier ablegen – wird Beitragsbild
      </div>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <Icon name="image" class="text-zinc-400" />
        <h3 class="text-sm font-semibold">Bilder</h3>
        <span class="text-xs text-zinc-500">Klick = Beitragsbild · „+ Text“ = zusätzlich im Text, Stelle frei wählbar</span>
        <span class="ml-auto" />
        <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" class="hidden" @change="upload(($event.target as HTMLInputElement).files)" />
        <button class="btn btn-sm" :disabled="uploading" title="Eigenes Bild hinzufügen (JPEG, PNG, WebP) – wird Beitragsbild. Auch per Drag & Drop." @click="fileInput?.click()">
          <Icon :name="uploading ? 'refresh' : 'upload'" :size="13" :class="uploading && 'animate-spin'" />{{ uploading ? "lädt …" : "Bild hochladen" }}
        </button>
        <button
          v-if="images?.images.length || draft.featured_image.startsWith('wp:')"
          class="btn btn-sm"
          :class="thumbnailId === null && '!ring-brand-500 text-brand-700 dark:text-brand-300'"
          @click="setThumbnail(thumbnailId === null ? '' : 'none')"
        >
          <Icon v-if="thumbnailId === null" name="check" :size="13" />ohne Beitragsbild
        </button>
      </div>
      <p v-if="uploadError" class="alert alert-error mb-3 text-xs"><Icon name="alert" :size="14" class="mt-0.5" />{{ uploadError }}</p>

      <div v-if="!images" class="grid grid-cols-3 gap-3 sm:grid-cols-5"><div v-for="n in 5" :key="n" class="skeleton aspect-square rounded-lg" /></div>
      <button
        v-else-if="!images.images.length"
        class="empty w-full cursor-pointer py-8 hover:border-zinc-950 dark:hover:border-white"
        :disabled="uploading"
        @click="fileInput?.click()"
      >
        <Icon name="upload" :size="20" />
        Keine brauchbaren Bilder in der Mail – eigenes Bild hochladen oder hierher ziehen.
      </button>
      <div v-else class="grid grid-cols-3 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        <ImageTile
          v-for="img in images.images"
          :key="img.id"
          :src="api.imageUrl(uid, img.id)"
          :alt="img.filename"
          :title="`${img.width}×${img.height}, ${kb(img.bytes)}`"
          :featured="thumbnailId === img.id"
          :inline="draft.inline_images.includes(img.id)"
          @select="setThumbnail(img.id)"
          @toggle-inline="toggleInline(img.id)"
        >
          <span class="truncate">{{ img.width }}×{{ img.height }} · {{ img.origin === "eigenes" ? "hochgeladen" : img.origin }}</span>
          <button v-if="img.origin === 'eigenes'" type="button" class="ml-auto shrink-0 hover:text-brand-700 dark:hover:text-brand-300" title="Hochgeladenes Bild entfernen" aria-label="Hochgeladenes Bild entfernen" @click="removeImage(img.id)">
            <Icon name="trash" :size="12" />
          </button>
        </ImageTile>
      </div>

      <MediaLibrary
        :uid="uid"
        :saved-key="mediaKey"
        :featured="thumbnailId"
        :inline="draft.inline_images"
        @select="setThumbnail"
        @toggle-inline="toggleInline"
      />

      <InlineImageList
        :ids="draft.inline_images"
        :positions="positions"
        :content-html="draft.content_html"
        :src-of="imageSrc"
        :label-of="imageLabel"
        @move="moveInline"
        @remove="removeInline"
      />

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
          <div v-html="previewHtml" />
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
