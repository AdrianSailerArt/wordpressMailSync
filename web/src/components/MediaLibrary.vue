<script setup lang="ts">
/**
 * Bilder aus der WordPress-Mediathek: Vorschläge passend zum gespeicherten Entwurf (Tags, Keyword)
 * und freie Suche. Gewählte Bilder werden beim Veröffentlichen nur verknüpft, nicht neu hochgeladen.
 */
import { computed, ref, watch } from "vue";
import { api, type WpMedia } from "../api";
import { cachedMedia, rememberMedia as remember } from "../media-cache";
import Icon from "./Icon.vue";
import ImageTile from "./ImageTile.vue";

const props = defineProps<{
  uid: number;
  /** ändert sich, wenn der Entwurf gespeichert wurde – dann neu vorschlagen */
  savedKey: string;
  /** aktuelles Beitragsbild (Bild-ID) */
  featured: string | null;
  inline: string[];
}>();
const emit = defineEmits<{ select: [id: string]; toggleInline: [id: string] }>();

const ref_ = (m: WpMedia) => `wp:${m.id}`;

const available = ref(true);
const loading = ref(false);
const error = ref("");
const suggestions = ref<WpMedia[]>([]);

const loadSuggestions = async () => {
  loading.value = true;
  error.value = "";
  try {
    const r = await api.mediaSuggestions(props.uid);
    available.value = r.available;
    remember([...r.items, ...r.selected]);
    suggestions.value = r.items;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
};
watch(() => [props.uid, props.savedKey], loadSuggestions, { immediate: true });

// ---- freie Suche
const query = ref("");
/** Suchbegriff der angezeigten Ergebnisse; leer = Vorschläge */
const searched = ref("");
const results = ref<WpMedia[]>([]);
const page = ref(1);
const pages = ref(1);
const total = ref(0);
const searching = ref(false);

const search = async (more = false) => {
  const q = more ? searched.value : query.value.trim();
  if (!q) return resetSearch();
  searching.value = true;
  error.value = "";
  try {
    const next = more ? page.value + 1 : 1;
    const r = await api.searchMedia(q, next);
    remember(r.items);
    results.value = more ? [...results.value, ...r.items] : r.items;
    page.value = next;
    pages.value = r.pages;
    total.value = r.total;
    searched.value = q;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    searching.value = false;
  }
};

const resetSearch = () => {
  query.value = "";
  searched.value = "";
  results.value = [];
};

/** Gewählte Mediathek-Bilder, die gerade nicht in der Liste stehen – vorn anzeigen */
const chosenElsewhere = computed(() => {
  const shown = new Set((searched.value ? results.value : suggestions.value).map((m) => m.id));
  return [props.featured, ...props.inline]
    .map((id) => (id ? cachedMedia(id) : undefined))
    .filter((m): m is WpMedia => !!m && !shown.has(m.id))
    .filter((m, i, list) => list.findIndex((x) => x.id === m.id) === i);
});

const list = computed(() => [...chosenElsewhere.value, ...(searched.value ? results.value : suggestions.value)]);

const caption = (m: WpMedia) => (m.matched?.length ? `passt: ${m.matched.join(", ")}` : m.title || m.filename);
</script>

<template>
  <div v-if="available" class="mt-6">
    <div class="label flex-wrap gap-x-2">
      <span>Aus der Mediathek</span>
      <span class="font-normal text-zinc-400">
        <template v-if="searched">{{ total }} Treffer für „{{ searched }}“</template>
        <template v-else>passend zu Tags und Fokus-Keyword · wird verknüpft, nicht neu hochgeladen</template>
      </span>
    </div>

    <form class="mb-3 flex flex-wrap items-end gap-2" role="search" @submit.prevent="search()">
      <div class="min-w-0 flex-1">
        <label :for="`media-search-${uid}`" class="sr-only">In der Mediathek suchen</label>
        <input :id="`media-search-${uid}`" v-model="query" type="search" class="field" placeholder="In der Mediathek suchen, z. B. Bandname" />
      </div>
      <button type="submit" class="btn btn-sm" :disabled="searching">
        <Icon :name="searching ? 'refresh' : 'search'" :size="13" :class="searching && 'animate-spin'" />Suchen
      </button>
      <button v-if="searched" type="button" class="btn btn-sm" @click="resetSearch">Vorschläge zeigen</button>
    </form>

    <div aria-live="polite">
      <p v-if="error" class="alert alert-error mb-3 text-xs">
        <Icon name="alert" :size="14" class="mt-0.5" />
        <span>Mediathek nicht erreichbar: {{ error }}</span>
        <button type="button" class="ml-auto underline underline-offset-2" @click="searched ? search(true) : loadSuggestions()">Erneut versuchen</button>
      </p>

      <div v-if="loading && !list.length" class="grid grid-cols-3 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        <div v-for="n in 4" :key="n" class="skeleton aspect-square rounded-lg" />
      </div>
      <p v-else-if="!list.length && !error" class="empty py-6 text-sm">
        <Icon name="image" :size="18" />
        <template v-if="searched">Nichts gefunden für „{{ searched }}“ – anderen Begriff versuchen.</template>
        <template v-else>Keine passenden Bilder in der Mediathek – oben nach Band oder Künstler suchen.</template>
      </p>
      <div v-else-if="list.length" class="grid grid-cols-3 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        <ImageTile
          v-for="m in list"
          :key="m.id"
          :src="m.thumb"
          :alt="m.alt || m.title"
          :title="`${m.title || m.filename}${m.width ? ` – ${m.width}×${m.height}` : ''}`"
          :featured="featured === ref_(m)"
          :inline="inline.includes(ref_(m))"
          @select="emit('select', ref_(m))"
          @toggle-inline="emit('toggleInline', ref_(m))"
        >
          <span class="truncate" :title="caption(m)">{{ caption(m) }}</span>
        </ImageTile>
      </div>

      <button v-if="searched && page < pages" type="button" class="btn btn-sm mt-3" :disabled="searching" @click="search(true)">
        {{ searching ? "lädt …" : "Mehr laden" }}
      </button>
    </div>
  </div>
</template>
