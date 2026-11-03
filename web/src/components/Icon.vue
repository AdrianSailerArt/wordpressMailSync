<script setup lang="ts">
/** Kleine Strich-Symbole (24er Raster, im Stil von Lucide) – ohne zusätzliche Abhängigkeit. */
import { PATHS, type IconName } from "../icons";

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 16 });

</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.9"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
  >
    <path v-for="d in PATHS[props.name]" :key="d" :d="d" />
  </svg>
</template>
