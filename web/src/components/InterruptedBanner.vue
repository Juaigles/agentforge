<script setup lang="ts">
// Aviso global: ejecuciones que un apagado del servidor dejó a medias. Ofrece reanudarlas o descartarlas.
import type { RunSummary } from '@shared/types';
import { LoaderCircle, SkipForward, TriangleAlert } from 'lucide-vue-next';
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { t, tn } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';
import Term from './Term.vue';

const router = useRouter();
const runsStore = useRuns();
const ui = useUi();

const pending = ref<RunSummary[]>([]);
const busy = ref<'resume' | 'dismiss' | null>(null);

async function load(): Promise<void> {
  try {
    pending.value = await api.runs.interrupted();
  } catch {
    /* sin conexión: se volverá a pedir cuando el canal de eventos reconecte */
  }
}
onMounted(load);
// Si el servidor se reinicia con la página abierta, el canal de eventos reconecta: se vuelve a preguntar.
watch(
  () => runsStore.connected,
  (connected, was) => {
    if (connected && was === false) void load();
  },
);

async function resume(): Promise<void> {
  busy.value = 'resume';
  try {
    const resumed = await api.runs.resumeInterrupted();
    runsStore.seed(resumed);
    pending.value = [];
    if (resumed.length === 1) {
      ui.success(t('interrupted.toast.resumedOne', { name: resumed[0].name }));
      await router.push(`/runs/${resumed[0].id}`);
    } else {
      ui.success(tn('interrupted.toast.resumedMany', resumed.length), { label: t('runs.toast.view'), to: '/runs' });
    }
  } catch (err) {
    ui.error(errorText(err));
    await load();
  } finally {
    busy.value = null;
  }
}

async function dismiss(): Promise<void> {
  busy.value = 'dismiss';
  try {
    await api.runs.dismissInterrupted();
    pending.value = [];
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div v-if="pending.length" class="interrupted" role="alert">
    <TriangleAlert class="ico" aria-hidden="true" />
    <div class="grow">
      <strong>
        {{ tn('interrupted.title', pending.length) }}
      </strong>
      <i18n-t keypath="interrupted.body" tag="p" class="small" scope="global">
        <template #run
          ><Term id="ejecucion">{{ t('interrupted.bodyRun') }}</Term></template
        >
      </i18n-t>
      <ul class="small">
        <li v-for="run in pending.slice(0, 3)" :key="run.id">
          <RouterLink :to="`/runs/${run.id}`">{{ run.name }}</RouterLink>
          <span v-if="run.input" class="muted truncate"> · {{ run.input }}</span>
        </li>
        <li v-if="pending.length > 3" class="muted">{{ t('interrupted.more', { n: pending.length - 3 }) }}</li>
      </ul>
    </div>
    <div class="actions">
      <button class="btn btn-primary" type="button" :disabled="!!busy" @click="resume">
        <LoaderCircle v-if="busy === 'resume'" class="spin" /><SkipForward v-else />
        {{ tn('interrupted.resume', pending.length) }}
      </button>
      <button class="btn" type="button" :disabled="!!busy" @click="dismiss">{{ t('interrupted.dismiss') }}</button>
    </div>
  </div>
</template>

<style scoped>
.interrupted {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin: 16px 24px 0;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border));
  border-radius: var(--radius);
  background: var(--warning-soft, color-mix(in srgb, var(--warning) 12%, var(--surface)));
}
.ico {
  width: 18px;
  height: 18px;
  flex: none;
  margin-top: 2px;
  color: var(--warning);
}
p {
  margin: 2px 0 6px;
  color: var(--text-2);
}
ul {
  margin: 0;
  padding-left: 18px;
}
li {
  max-width: 100%;
}
.actions {
  display: flex;
  gap: 8px;
  flex: none;
}
@media (max-width: 720px) {
  .interrupted {
    flex-wrap: wrap;
    margin: 12px 14px 0;
  }
  .ico {
    display: none;
  }
  .actions {
    width: 100%;
  }
}
</style>
