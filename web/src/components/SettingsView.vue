<script setup lang="ts">
import { computed } from "vue";
import type { Status } from "../api";
import Icon from "./Icon.vue";
import MailAccounts from "./MailAccounts.vue";
import ModelPicker from "./ModelPicker.vue";
import PageHeader from "./PageHeader.vue";

/** Sprachmodell und Postfächer wählen, die übrigen Einstellungen aus der .env ansehen. */
const props = defineProps<{ status: Status }>();
const emit = defineEmits<{ changed: [] }>();

const groups = computed(() => {
  const c = props.status.config;
  return [
    {
      title: "WordPress",
      icon: "globe" as const,
      rows: [
        ["Website", c.wpUrl],
        ["Neue Beiträge", c.wpStatus === "publish" ? "sofort veröffentlichen" : c.wpStatus === "draft" ? "als Entwurf" : c.wpStatus],
        ["SEO-Plugin", c.seoPlugin],
        ["Kategorien", c.categories.join(", ")],
      ],
    },
    {
      title: "Zeitpläne",
      icon: "clock" as const,
      rows: [
        ["Vorschläge", `${c.suggestSchedule} (${c.timezone})`],
        ["Veröffentlichen", c.autoPublish ? `${props.status.schedule} (${c.timezone})` : "aus (AUTO_PUBLISH=false)"],
        ["Limit", `${c.perRun} pro Lauf · Richtwert ${props.status.limit} pro Tag (nur für den Zeitplan)`],
        ["Benachrichtigungen", `${props.status.pushSubscribers} Browser angemeldet`],
      ],
    },
  ];
});
</script>

<template>
  <PageHeader title="Einstellungen" description="Sprachmodell und Postfächer stellst du hier ein – der Rest kommt aus der .env des Servers." />

  <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <section class="card">
      <div class="card-header">
        <Icon name="cpu" class="text-zinc-400" />
        <h2 class="text-sm font-semibold">Sprachmodell</h2>
        <span class="ml-auto truncate text-xs text-zinc-500">{{ status.config.model }}</span>
      </div>
      <div class="card-body">
        <ModelPicker @changed="emit('changed')" />
      </div>
    </section>

    <div class="space-y-6">
      <MailAccounts @changed="emit('changed')" />
      <section v-for="g in groups" :key="g.title" class="card">
        <div class="card-header">
          <Icon :name="g.icon" class="text-zinc-400" />
          <h2 class="text-sm font-semibold">{{ g.title }}</h2>
        </div>
        <dl class="divide-y divide-zinc-950/5 text-sm dark:divide-white/5">
          <div v-for="[k, v] in g.rows" :key="k" class="grid gap-1 px-4 py-2.5 sm:grid-cols-3 sm:gap-4">
            <dt class="text-zinc-500">{{ k }}</dt>
            <dd class="break-words sm:col-span-2">{{ v }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>
