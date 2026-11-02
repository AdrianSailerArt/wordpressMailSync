<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, formatDate, type LogEntry } from "../api";

const entries = ref<LogEntry[]>([]);
const error = ref("");

const labels: Record<LogEntry["kind"], [string, string]> = {
  published: ["Veröffentlicht", "ok"],
  skipped: ["Übersprungen", ""],
  error: ["Fehler", "err"],
  run: ["Lauf", "warn"],
};

onMounted(async () => {
  try {
    entries.value = await api.log();
  } catch (e) {
    error.value = (e as Error).message;
  }
});
</script>

<template>
  <div v-if="error" class="error-box">{{ error }}</div>
  <section class="card">
    <p v-if="!entries.length" class="muted">Noch keine Einträge.</p>
    <table v-else>
      <thead>
        <tr><th>Zeit</th><th>Ereignis</th><th>Details</th></tr>
      </thead>
      <tbody>
        <tr v-for="e in entries" :key="e.id">
          <td class="time">{{ formatDate(e.ts) }}</td>
          <td><span :class="['badge', labels[e.kind][1]]">{{ labels[e.kind][0] }}</span></td>
          <td>
            <a v-if="e.link" :href="e.link" target="_blank">{{ e.subject }}</a>
            <strong v-else-if="e.subject">{{ e.subject }}</strong>
            <div class="muted">{{ e.detail }}</div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 500; padding: 0 8px 8px; }
td { padding: 8px; border-top: 1px solid var(--border); vertical-align: top; }
.time { white-space: nowrap; font-variant-numeric: tabular-nums; }
</style>
