<script setup lang="ts">
/** Postfächer im Dashboard: Liste, anlegen, bearbeiten, löschen. */
import { onMounted, ref } from "vue";
import { api, type MailAccount } from "../api";
import Icon from "./Icon.vue";
import MailAccountForm from "./MailAccountForm.vue";

const emit = defineEmits<{ changed: [] }>();

const accounts = ref<MailAccount[] | null>(null);
const error = ref("");
/** „neu“ oder die Nummer des bearbeiteten Postfachs */
const editing = ref<number | "neu" | null>(null);

async function load() {
  try {
    accounts.value = await api.mailAccounts();
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

function onSaved(list: MailAccount[]) {
  accounts.value = list;
  editing.value = null;
  emit("changed");
}

async function remove(a: MailAccount) {
  if (!confirm(`Postfach „${a.name}“ entfernen?\n\nDie Mails darin bleiben unangetastet, das Dashboard ruft es nur nicht mehr ab.`)) return;
  try {
    accounts.value = await api.deleteMailAccount(a.nr);
    editing.value = null;
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<template>
  <section class="card overflow-hidden">
    <div class="card-header">
      <Icon name="mail" class="text-zinc-400" />
      <h2 class="text-sm font-semibold">Postfächer</h2>
      <span v-if="accounts" class="text-xs text-zinc-500">{{ accounts.length }}</span>
      <button class="btn btn-sm ml-auto" :disabled="editing === 'neu'" @click="editing = 'neu'"><Icon name="plus" :size="12" />Postfach</button>
    </div>

    <p v-if="error" class="alert alert-error m-4 text-xs"><Icon name="alert" :size="14" class="mt-0.5" />{{ error }}</p>
    <MailAccountForm v-if="editing === 'neu'" @saved="onSaved" @close="editing = null" />

    <div v-if="accounts && !accounts.length && editing !== 'neu'" class="p-4">
      <div class="empty py-8">
        <Icon name="inbox" :size="22" />
        Noch kein Postfach – mit „+ Postfach“ das erste einrichten.
      </div>
    </div>

    <ul class="divide-y divide-zinc-950/15 dark:divide-white/10">
      <li v-for="a in accounts ?? []" :key="a.nr">
        <MailAccountForm v-if="editing === a.nr" :account="a" @saved="onSaved" @close="editing = null" />
        <div v-else class="flex items-start gap-3 px-4 py-3">
          <span class="mt-1.5 size-2 shrink-0 rounded-full" :class="a.error ? 'bg-brand-600' : 'bg-emerald-500'" :title="a.error ? 'Letzter Abruf fehlgeschlagen' : 'in Ordnung'" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ a.name }}</p>
            <p class="truncate text-xs text-zinc-500">
              <template v-if="a.name !== a.user">{{ a.user }} · </template>{{ a.host }}<template v-if="a.port !== 993">:{{ a.port }}</template> · {{ a.folder }}
              <template v-if="a.processedFolder"> → {{ a.processedFolder }}</template>
            </p>
            <p v-if="a.error" class="mt-1 break-words text-xs text-brand-700 dark:text-brand-300">{{ a.error }}</p>
          </div>
          <button class="btn btn-ghost btn-sm size-7 px-0" title="Bearbeiten" @click="editing = a.nr"><Icon name="pencil" :size="13" /></button>
          <button class="btn btn-ghost btn-danger btn-sm size-7 px-0" title="Entfernen" @click="remove(a)"><Icon name="trash" :size="13" /></button>
        </div>
      </li>
    </ul>
  </section>
</template>
