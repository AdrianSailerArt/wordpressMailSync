<script setup lang="ts">
/** Bildkachel im Editor: Klick = Beitragsbild, „+ Text“ = zusätzlich im Text. Für Mail- und Mediathek-Bilder. */
defineProps<{
  src: string;
  alt: string;
  /** Tooltip der Kachel, z. B. Größe */
  title: string;
  featured: boolean;
  inline: boolean;
}>();
const emit = defineEmits<{ select: []; toggleInline: [] }>();
</script>

<template>
  <figure class="group relative">
    <button
      type="button"
      class="block aspect-square w-full overflow-hidden rounded-lg bg-zinc-100 ring-offset-2 ring-offset-white transition dark:bg-zinc-800 dark:ring-offset-zinc-900"
      :class="featured ? 'ring-2 ring-brand-600 dark:ring-brand-400' : 'opacity-85 ring-1 ring-zinc-950/40 hover:opacity-100 dark:ring-white/10'"
      :title="`Als Beitragsbild verwenden – ${title}`"
      :aria-pressed="featured"
      @click="emit('select')"
    >
      <img :src="src" :alt="alt" loading="lazy" class="size-full object-cover transition group-hover:scale-[1.03]" />
    </button>
    <span v-if="featured" class="absolute top-1.5 left-1.5 rounded-md bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">Beitragsbild</span>
    <button
      type="button"
      class="absolute top-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold shadow transition"
      :class="inline ? 'bg-emerald-600 text-white' : 'bg-white/90 text-zinc-700 opacity-0 group-hover:opacity-100 focus:opacity-100 dark:bg-zinc-900/90 dark:text-zinc-200'"
      title="Zusätzlich im Text nach der Einleitung einfügen"
      :aria-pressed="inline"
      @click="emit('toggleInline')"
    >
      {{ inline ? "✓ im Text" : "+ Text" }}
    </button>
    <figcaption class="mt-1 flex items-center gap-1 text-[11px] tabular-nums text-zinc-400">
      <slot />
    </figcaption>
  </figure>
</template>
