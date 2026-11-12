<script setup lang="ts">
// Aviso global: ejecuciones detenidas a la espera de que una persona apruebe o rechace. Aparece en cualquier
// pantalla (también en el monitor de la propia ejecución) y permite decidir sin salir de ella.
import type { Approval } from '@shared/types';
import { Check, LoaderCircle, UserCheck, X } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { t, tn } from '@/i18n';
import { announce } from '@/lib/a11y';
import { api, errorText } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useUi } from '@/stores/ui';
import MarkdownView from './MarkdownView.vue';
import Term from './Term.vue';

const ui = useUi();

const pending = ref<Approval[]>([]);
const comments = reactive<Record<string, string>>({});
const busy = ref<string | null>(null);
/** Aprobaciones cuyo texto completo está desplegado. */
const expanded = reactive(new Set<string>());
/** Ids ya vistos: null hasta la primera lista, para no avisar de lo que ya esperaba al abrir la página. */
let seen: Set<string> | null = null;
let source: EventSource | null = null;

/** Sustituye la lista y avisa (lector de pantalla y aviso con enlace) de las aprobaciones que acaban de aparecer. */
function receive(list: Approval[]): void {
  const fresh = seen ? list.filter((a) => !seen!.has(a.id)) : [];
  seen = new Set(list.map((a) => a.id));
  pending.value = list;
  for (const approval of fresh) {
    const message = t('approvals.toast.waiting', { name: approval.runName });
    announce(message);
    ui.info(message, { label: t('approvals.toast.decide'), to: `/runs/${approval.runId}` });
  }
}

async function load(): Promise<void> {
  try {
    receive(await api.approvals.pending());
  } catch {
    /* sin conexión: el canal en vivo lo volverá a enviar al reconectar */
  }
}
// El servidor avisa por su propio canal cada vez que cambia el conjunto de aprobaciones pendientes (y envía la
// lista al conectar y al reconectar): no hace falta volver a pedirla con cada evento de ejecución.
onMounted(() => {
  if (typeof EventSource === 'undefined') return void load();
  source = new EventSource('/api/stream/approvals');
  source.addEventListener('approvals', (ev) => receive(JSON.parse((ev as MessageEvent).data) as Approval[]));
});
onBeforeUnmount(() => {
  source?.close();
  source = null;
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
  /* El contenedor que desplaza la página es `main`: pegado arriba, el aviso se ve estés donde estés. */
  position: sticky;
  top: 0;
  z-index: 30;
  max-height: 50vh;
  overflow-y: auto;
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
