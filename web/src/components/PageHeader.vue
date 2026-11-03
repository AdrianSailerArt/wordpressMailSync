<script setup lang="ts">
/** Kopf einer Ansicht: Titel, kurze Beschreibung, Aktionen rechts. */
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="mb-6 flex flex-wrap items-end gap-x-6 gap-y-4">
    <div class="mr-auto min-w-0">
      <h1 class="text-xl font-semibold tracking-tight text-zinc-950 sm:text-2xl dark:text-white">{{ title }}</h1>
      <p v-if="description || $slots.description" class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
