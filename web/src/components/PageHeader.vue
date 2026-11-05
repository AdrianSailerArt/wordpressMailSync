<script setup lang="ts">
/** Kopf einer Ansicht: gekippter Titelkasten, kurze Beschreibung, Aktionen rechts. */
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="mb-8 flex flex-wrap items-end gap-x-6 gap-y-5">
    <div class="mr-auto min-w-0">
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="description || $slots.description" class="mt-4 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-3">
      <slot name="actions" />
    </div>
  </header>
</template>
