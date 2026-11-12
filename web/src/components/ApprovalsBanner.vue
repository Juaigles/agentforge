<script setup lang="ts">
// Aviso global: ejecuciones detenidas a la espera de que una persona apruebe o rechace. Aparece en cualquier
// pantalla (también en el monitor de la propia ejecución) y permite decidir sin salir de ella.
import type { Approval } from '@shared/types';
import { Check, LoaderCircle, UserCheck, X } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { t, tn } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';
import MarkdownView from './MarkdownView.vue';
import Term from './Term.vue';

const runsStore = useRuns();
const ui = useUi();

const pending = ref<Approval[]>([]);
const comments = reactive<Record<string, string>>({});
const busy = ref<string | null>(null);
/** Aprobaciones cuyo texto completo está desplegado. */
const expanded = reactive(new Set<string>());
let timer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<void> {
  try {
    pending.value = await api.approvals.pending();
  } catch {
    /* sin conexión: se volverá a pedir con el siguiente cambio */
  }
}
onMounted(load);
// Una ejecución que pasa a «en espera» (o que deja de estarlo) llega por el canal en vivo: se vuelve a preguntar.
watch(
  () => [runsStore.version, runsStore.connected],
  () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(load, 150);
  },
);
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

async function decide(approval: Approval, approved: boolean): Promise<void> {
  busy.value = approval.id;
  try {
    await api.approvals.decide(approval.id, approved, comments[approval.id] ?? '');
    ui.success(t(approved ? 'approvals.toast.approved' : 'approvals.toast.rejected', { name: approval.runName }));
    delete comments[approval.id];
    pending.value = pending.value.filter((a) => a.id !== approval.id);
  } catch (err) {
    ui.error(errorText(err));
    await load();
  } finally {
    busy.value = null;
  }
}

const isLong = (text: string) => text.length > 280 || text.split('\n').length > 6;
</script>

<template>
  <section v-if="pending.length" class="approvals" aria-labelledby="approvals-title">
    <h2 id="approvals-title" class="title">
      <UserCheck aria-hidden="true" />
      {{ tn('approvals.title', pending.length) }}
    </h2>
    <i18n-t keypath="approvals.intro" tag="p" class="small muted intro" scope="global">
      <template #approval
        ><Term id="aprobacion">{{ t('approvals.introApproval') }}</Term></template
      >
      <template #run
        ><Term id="ejecucion">{{ t('approvals.introRun') }}</Term></template
      >
    </i18n-t>
    <ul>
      <li v-for="approval in pending" :key="approval.id" class="approval">
        <div class="head">
          <RouterLink :to="`/runs/${approval.runId}`" class="run">{{ approval.runName }}</RouterLink>
          <span class="muted small">· {{ approval.nodeLabel }} · {{ formatDateTime(approval.createdAt) }}</span>
        </div>
        <div class="message" :class="{ clipped: isLong(approval.message) && !expanded.has(approval.id) }">
          <MarkdownView :source="approval.message" />
        </div>
        <button
          v-if="isLong(approval.message)"
          class="btn btn-ghost btn-sm more"
          type="button"
          :aria-expanded="expanded.has(approval.id)"
          @click="expanded.has(approval.id) ? expanded.delete(approval.id) : expanded.add(approval.id)"
        >
          {{ expanded.has(approval.id) ? t('approvals.viewLess') : t('approvals.viewAll') }}
        </button>
        <div class="decide">
          <label class="sr-only" :for="`apr-comment-${approval.id}`">{{ t('approvals.commentLabel', { name: approval.runName }) }}</label>
          <input
            :id="`apr-comment-${approval.id}`"
            v-model="comments[approval.id]"
            class="input"
            maxlength="2000"
            :placeholder="t('approvals.commentPlaceholder')"
            :disabled="busy === approval.id"
          />
          <button class="btn btn-primary" type="button" :disabled="busy !== null" @click="decide(approval, true)">
            <LoaderCircle v-if="busy === approval.id" class="spin" /><Check v-else /> {{ t('approvals.approve') }}
          </button>
          <button class="btn" type="button" :disabled="busy !== null" @click="decide(approval, false)"><X /> {{ t('approvals.reject') }}</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.approvals {
  margin: 16px 24px 0;
  padding: 14px 16px;
  border: 1px solid var(--warning);
  border-radius: var(--radius);
  background: var(--warning-soft);
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 14.5px;
}
.title svg {
  width: 17px;
  height: 17px;
  color: var(--warning);
  flex: none;
}
.intro {
  margin: 4px 0 10px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.approval {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  min-width: 0;
}
.head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  align-items: baseline;
}
.run {
  font-weight: 650;
  text-decoration: underline;
}
.message {
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.message.clipped {
  max-height: 132px;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, #000 70%, transparent);
}
.more {
  margin-top: 2px;
}
.decide {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.decide .input {
  flex: 1 1 220px;
  min-width: 0;
}
@media (max-width: 640px) {
  .approvals {
    margin: 12px 12px 0;
  }
}
</style>
