<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api, formatDate, type OriginalMail } from "../api";
import { compareDates, foreignLinks, htmlToPlain } from "../facts";

/** Original-Mail wie im Mailprogramm, daneben eine Prüfliste gegen den Beitrag. */
const props = defineProps<{ uid: number; original: OriginalMail | null; article?: { title: string; content_html: string } }>();

const read = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ohne Speicher gilt die Auswahl nur bis zum Neuladen
  }
};

const mode = ref<"html" | "text">(read("mail-view", "html") === "text" ? "text" : "html");
const remoteImages = ref(read("mail-images", "1") === "1");
watch(mode, (v) => write("mail-view", v));
watch(remoteImages, (v) => write("mail-images", v ? "1" : "0"));

const showHtml = computed(() => mode.value === "html" && !!props.original?.hasHtml);
const frameUrl = computed(() => api.originalHtmlUrl(props.uid, remoteImages.value));

// Inhalt per srcdoc einsetzen statt nachladen – manche Browser-Erweiterungen blockieren Unterseiten im iframe
const frameHtml = ref("");
const frameError = ref("");
watch([showHtml, frameUrl], async () => {
  if (!showHtml.value) return;
  frameHtml.value = frameError.value = "";
  try {
    frameHtml.value = await api.originalHtml(props.uid, remoteImages.value);
  } catch (e) {
    frameError.value = (e as Error).message;
  }
}, { immediate: true });

const size = (bytes: number) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

const articleText = computed(() => (props.article ? `${props.article.title}\n${htmlToPlain(props.article.content_html)}` : ""));
const dates = computed(() => (props.article && props.original ? compareDates(props.original.body, articleText.value) : null));
const strangeLinks = computed(() =>
  props.article && props.original ? foreignLinks(props.article.content_html, props.original.links.map((l) => l.url), props.original.body) : [],
);
const usedInArticle = (url: string) => !!props.article?.content_html.includes(url.replace(/&/g, "&amp;")) || !!props.article?.content_html.includes(url);
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const problems = computed(() => (dates.value?.onlyArticle.length ?? 0) + (dates.value?.fromMail.filter((d) => d.match !== "ok").length ?? 0) + strangeLinks.value.length);
</script>

<template>
  <p v-if="!original" class="text-sm text-zinc-500">Original wird geladen …</p>
  <div v-else class="grid gap-4" :class="article && 'xl:grid-cols-[minmax(0,1fr)_18rem]'">
    <div class="min-w-0 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <!-- Kopfzeilen -->
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
        <dt class="text-zinc-500">Betreff</dt>
        <dd class="font-medium text-zinc-900 dark:text-zinc-100">{{ original.subject }}</dd>
        <dt class="text-zinc-500">Von</dt>
        <dd class="truncate">{{ original.sender }}</dd>
        <template v-if="original.to">
          <dt class="text-zinc-500">An</dt>
          <dd class="truncate">{{ original.to }}</dd>
        </template>
        <dt class="text-zinc-500">Datum</dt>
        <dd>{{ formatDate(original.date) }}</dd>
        <template v-if="original.attachments.length">
          <dt class="text-zinc-500">Anhänge</dt>
          <dd class="flex flex-wrap gap-1.5">
            <span v-for="a in original.attachments" :key="a.filename" class="rounded bg-zinc-200/70 px-1.5 py-0.5 dark:bg-zinc-800">
              {{ a.filename }} <span class="text-zinc-500">· {{ size(a.size) }}</span>
            </span>
          </dd>
        </template>
      </dl>

      <!-- Darstellung -->
      <div class="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
        <div v-if="original.hasHtml" class="flex rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-900">
          <button
            v-for="[id, label] in ([['html', 'Wie im Mailprogramm'], ['text', 'Nur Text']] as const)"
            :key="id"
            class="rounded px-2 py-0.5 transition-colors"
            :class="mode === id ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'"
            @click="mode = id"
          >
            {{ label }}
          </button>
        </div>
        <span v-else class="text-zinc-500">Reine Text-Mail</span>
        <label v-if="showHtml" class="flex items-center gap-1.5 text-zinc-500" title="Bilder vom Server des Absenders laden – der Absender sieht dann, dass die Mail geöffnet wurde">
          <input v-model="remoteImages" type="checkbox" class="accent-zinc-900 dark:accent-white" />
          Externe Bilder
        </label>
        <a v-if="showHtml" :href="frameUrl" target="_blank" rel="noopener" class="ml-auto text-zinc-500 underline-offset-2 hover:underline">In neuem Tab</a>
      </div>

      <!-- sandbox ohne allow-scripts/allow-same-origin: die Mail kann nichts ausführen und nicht aufs Dashboard zugreifen -->
      <p v-if="showHtml && frameError" class="px-4 py-3 text-sm text-rose-600 dark:text-rose-400">{{ frameError }}</p>
      <div v-else-if="showHtml && !frameHtml" class="h-[70vh] animate-pulse bg-zinc-50 dark:bg-zinc-900" />
      <iframe
        v-else-if="showHtml"
        :srcdoc="frameHtml"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        class="block h-[70vh] w-full bg-white"
        title="Original-Mail"
      />
      <div v-else class="max-h-[70vh] overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{{ original.body }}</div>
    </div>

    <!-- Prüfliste -->
    <aside v-if="article && dates" class="space-y-5 text-xs">
      <p class="rounded-lg px-3 py-2" :class="problems ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300' : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'">
        {{ problems ? `${problems} Stelle${problems === 1 ? "" : "n"} bitte prüfen` : "Termine und Links passen zur Mail" }}
      </p>

      <section>
        <p class="eyebrow mb-2">Termine aus der Mail</p>
        <p v-if="!dates.fromMail.length" class="text-zinc-500">Keine Datumsangaben gefunden.</p>
        <ul v-else class="space-y-1">
          <li v-for="d in dates.fromMail" :key="d.date.key + d.date.year" class="flex items-baseline gap-2">
            <span class="w-3 shrink-0 text-center" :class="d.match === 'ok' ? 'text-emerald-600' : 'text-amber-600'">{{ d.match === "ok" ? "✓" : "!" }}</span>
            <span class="tabular-nums">{{ d.date.text }}</span>
            <span v-if="d.match === 'missing'" class="text-zinc-500">fehlt im Beitrag</span>
            <span v-else-if="d.match === 'year'" class="text-amber-700 dark:text-amber-400">anderes Jahr im Beitrag</span>
          </li>
        </ul>
      </section>

      <section v-if="dates.onlyArticle.length">
        <p class="eyebrow mb-2 text-rose-600 dark:text-rose-400">Nur im Beitrag – erfunden?</p>
        <ul class="space-y-1">
          <li v-for="d in dates.onlyArticle" :key="d.key + d.year" class="flex items-baseline gap-2 text-rose-700 dark:text-rose-300">
            <span class="w-3 shrink-0 text-center">!</span><span class="tabular-nums">{{ d.text }}</span>
          </li>
        </ul>
      </section>

      <section v-if="strangeLinks.length">
        <p class="eyebrow mb-2 text-rose-600 dark:text-rose-400">Links nicht aus der Mail</p>
        <ul class="space-y-1">
          <li v-for="l in strangeLinks" :key="l.url" class="truncate text-rose-700 dark:text-rose-300">
            <a :href="l.url" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2" :title="l.url">{{ l.label || host(l.url) }}</a>
            <span class="text-zinc-500"> · {{ host(l.url) }}</span>
          </li>
        </ul>
      </section>

      <section v-if="original.links.length">
        <p class="eyebrow mb-2">Links in der Mail</p>
        <ul class="space-y-1">
          <li v-for="l in original.links" :key="l.url" class="flex items-baseline gap-2">
            <span
              class="w-3 shrink-0 text-center"
              :class="l.blocked ? 'text-zinc-400' : usedInArticle(l.url) ? 'text-emerald-600' : 'text-zinc-300 dark:text-zinc-700'"
              :title="l.blocked ? 'Download/Presse/Hörprobe – darf nicht in den Artikel' : usedInArticle(l.url) ? 'im Beitrag verlinkt' : 'nicht im Beitrag'"
            >{{ l.blocked ? "⊘" : usedInArticle(l.url) ? "✓" : "·" }}</span>
            <a :href="l.url" target="_blank" rel="noopener noreferrer" class="min-w-0 truncate underline-offset-2 hover:underline" :class="l.blocked && 'text-zinc-400 line-through'" :title="l.url">
              {{ l.label }}
            </a>
          </li>
        </ul>
        <p class="mt-2 text-zinc-400">✓ im Beitrag · ⊘ darf nicht rein</p>
      </section>
    </aside>
  </div>
</template>
