<script setup lang="ts">
// Programación de un workflow: cada cierto tiempo o a una hora fija cada día.
import type { Schedule, ScheduleInput, ScheduleKind } from '@shared/types';
import { CircleAlert, LoaderCircle, Play, Trash2 } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError, errorText } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { describeSchedule, splitInterval, toMinutes, type IntervalUnit } from '@/lib/transfer';
import { useUi } from '@/stores/ui';
import AppModal from './AppModal.vue';
import Term from './Term.vue';

const props = defineProps<{ workflowId: string; workflowName: string; defaultInput?: string }>();
const emit = defineEmits<{ close: []; changed: [schedule: Schedule | null] }>();
const ui = useUi();
const router = useRouter();

const loading = ref(true);
const loadError = ref<string | null>(null);
const saved = ref<Schedule | null>(null);
const busy = ref<'save' | 'remove' | 'run' | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const formError = ref<string | null>(null);

const form = reactive({
  enabled: true,
  kind: 'interval' as ScheduleKind,
  every: 60,
  unit: 'minutes' as IntervalUnit,
  time: '09:00',
  input: props.defaultInput ?? '',
});

function fill(schedule: Schedule): void {
  form.enabled = schedule.enabled;
  form.kind = schedule.kind;
  if (schedule.intervalMinutes) Object.assign(form, { every: splitInterval(schedule.intervalMinutes).value, unit: splitInterval(schedule.intervalMinutes).unit });
  if (schedule.time) form.time = schedule.time;
  form.input = schedule.input;
}

onMounted(async () => {
  try {
    saved.value = await api.workflows.schedule.get(props.workflowId);
    if (saved.value) fill(saved.value);
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
});

const minutes = computed(() => toMinutes(Number(form.every), form.unit));
const intervalError = computed(() => {
  if (form.kind !== 'interval') return '';
  if (!Number.isFinite(minutes.value) || !Number.isInteger(Number(form.every)) || minutes.value < 1) return 'Indica un número entero de al menos 1 minuto.';
  return minutes.value > 43_200 ? 'El intervalo máximo son 30 días.' : '';
});
const timeError = computed(() => (form.kind === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time) ? 'Indica una hora válida (HH:MM).' : ''));
const summary = computed(() =>
  intervalError.value || timeError.value ? '' : describeSchedule({ kind: form.kind, intervalMinutes: minutes.value, time: form.time }),
);

function payload(): ScheduleInput {
  return {
    kind: form.kind,
    intervalMinutes: form.kind === 'interval' ? minutes.value : null,
    time: form.kind === 'daily' ? form.time : null,
    input: form.input,
    enabled: form.enabled,
  };
}

async function save(): Promise<void> {
  if (intervalError.value || timeError.value || busy.value) return;
  busy.value = 'save';
  formError.value = null;
  fieldErrors.value = {};
  try {
    saved.value = await api.workflows.schedule.save(props.workflowId, payload());
    emit('changed', saved.value);
    ui.success(saved.value.enabled ? `«${props.workflowName}» se ejecutará ${describeSchedule(saved.value)}.` : 'Programación guardada, pero desactivada.');
    emit('close');
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) fieldErrors.value = Object.fromEntries(err.issues.map((i) => [i.path, i.message]));
    else formError.value = errorText(err);
  } finally {
    busy.value = null;
  }
}

async function remove(): Promise<void> {
  busy.value = 'remove';
  try {
    await api.workflows.schedule.remove(props.workflowId);
    saved.value = null;
    emit('changed', null);
    ui.success('Programación eliminada.');
    emit('close');
  } catch (err) {
    formError.value = errorText(err);
  } finally {
    busy.value = null;
  }
}

async function runNow(): Promise<void> {
  busy.value = 'run';
  formError.value = null;
  try {
    const run = await api.workflows.schedule.runNow(props.workflowId);
    emit('close');
    await router.push(`/runs/${run.id}`);
  } catch (err) {
    formError.value = errorText(err);
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <AppModal :title="`Programar «${workflowName}»`" :width="560" @close="emit('close')">
    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 34px" />
      <div class="skeleton" style="height: 84px" />
    </div>
    <div v-else-if="loadError" class="callout danger" role="alert"><CircleAlert /><span>{{ loadError }}</span></div>

    <form v-else id="schedule-form" class="col" style="gap: 16px" novalidate @submit.prevent="save">
      <p class="muted small">
        El <Term id="workflow">workflow</Term> se lanzará solo, con el texto de entrada indicado, mientras el servidor de AgentForge esté en marcha. Cada
        vez queda registrada como una <Term id="ejecucion">ejecución</Term> más, marcada como «programada».
      </p>

      <label class="check">
        <input v-model="form.enabled" type="checkbox" class="switch" />
        <span>
          <strong>Programación activa</strong>
          <span class="muted small" style="display: block">Desactívala para pausarla sin perder la configuración.</span>
        </span>
      </label>

      <div class="field">
        <span class="label">Cuándo</span>
        <div class="segmented" role="radiogroup" aria-label="Tipo de programación">
          <button type="button" role="radio" :aria-checked="form.kind === 'interval'" :class="{ active: form.kind === 'interval' }" @click="form.kind = 'interval'">
            Cada cierto tiempo
          </button>
          <button type="button" role="radio" :aria-checked="form.kind === 'daily'" :class="{ active: form.kind === 'daily' }" @click="form.kind = 'daily'">Cada día a una hora</button>
        </div>
      </div>

      <div v-if="form.kind === 'interval'" class="field">
        <label for="sch-every">Repetir cada</label>
        <div class="row">
          <input id="sch-every" v-model.number="form.every" class="input num" type="number" min="1" step="1" style="width: 110px" :aria-invalid="!!(intervalError || fieldErrors.intervalMinutes)" />
          <select v-model="form.unit" class="select" style="width: auto" aria-label="Unidad del intervalo">
            <option value="minutes">minutos</option>
            <option value="hours">horas</option>
            <option value="days">días</option>
          </select>
        </div>
        <span v-if="intervalError || fieldErrors.intervalMinutes" class="error" role="alert">{{ intervalError || fieldErrors.intervalMinutes }}</span>
        <span v-else class="hint">El intervalo se cuenta desde que guardas y, después, desde cada lanzamiento.</span>
      </div>
      <div v-else class="field">
        <label for="sch-time">Hora</label>
        <input id="sch-time" v-model="form.time" class="input num" type="time" style="width: 140px" :aria-invalid="!!(timeError || fieldErrors.time)" />
        <span v-if="timeError || fieldErrors.time" class="error" role="alert">{{ timeError || fieldErrors.time }}</span>
        <span v-else class="hint">Hora local del equipo donde se ejecuta AgentForge.</span>
      </div>

      <div class="field">
        <label for="sch-input">Entrada de cada ejecución</label>
        <textarea id="sch-input" v-model="form.input" class="textarea" rows="3" placeholder="Texto con el que arranca el workflow cada vez" />
      </div>

      <div v-if="saved" class="state small">
        <div>
          <span class="eyebrow">Próxima ejecución</span>
          <span v-if="saved.enabled && saved.nextRunAt" :title="formatDateTime(saved.nextRunAt)">{{ formatDateTime(saved.nextRunAt) }} ({{ relativeTime(saved.nextRunAt) }})</span>
          <span v-else class="muted">Pausada</span>
        </div>
        <div>
          <span class="eyebrow">Última ejecución</span>
          <RouterLink v-if="saved.lastRunId && saved.lastRunAt" :to="`/runs/${saved.lastRunId}`" @click="emit('close')">{{ formatDateTime(saved.lastRunAt) }}</RouterLink>
          <span v-else class="muted">Todavía ninguna</span>
        </div>
        <p v-if="saved.lastError" class="last-error"><CircleAlert /> {{ saved.lastError }}</p>
      </div>
      <p v-else-if="summary" class="small muted">Al guardar, se ejecutará {{ summary }}.</p>

      <div v-if="formError" class="callout danger" role="alert"><CircleAlert /><span>{{ formError }}</span></div>
    </form>

    <template #footer>
      <template v-if="saved">
        <button class="btn btn-ghost btn-danger" type="button" style="margin-right: auto" :disabled="!!busy" @click="remove"><Trash2 /> Quitar programación</button>
        <button class="btn" type="button" :disabled="!!busy" title="Lanza ahora una ejecución con la entrada guardada" @click="runNow">
          <LoaderCircle v-if="busy === 'run'" class="spin" /><Play v-else /> Ejecutar ahora
        </button>
      </template>
      <button class="btn" type="button" @click="emit('close')">Cancelar</button>
      <button class="btn btn-primary" type="submit" form="schedule-form" :disabled="loading || !!loadError || !!busy || !!intervalError || !!timeError">
        <LoaderCircle v-if="busy === 'save'" class="spin" /> Guardar programación
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.state {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 16px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.state > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.last-error {
  grid-column: 1 / -1;
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0;
  color: var(--danger);
}
.last-error svg {
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 2px;
}
@media (max-width: 480px) {
  .state {
    grid-template-columns: 1fr;
  }
}
</style>
