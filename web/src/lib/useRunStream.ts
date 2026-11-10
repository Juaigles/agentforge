// Composable que mantiene el estado de una ejecución al día mediante SSE.
import type { Run, RunEvent } from '@shared/types';
import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue';
import { api, errorText } from './api';
import { isActiveStatus } from './format';
import { applyEvent, blankFromRun, fromRun, totalUsage, type RunLive } from './run-state';

export function useRunStream(runId: Ref<string | null>) {
  const run = ref<Run | null>(null);
  const live = ref<RunLive | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let source: EventSource | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  function close(): void {
    source?.close();
    source = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  /** Vuelve a pedir la ejecución para completar datos que no viajan en los eventos (p. ej. el prompt renderizado). */
  function scheduleRefresh(id: string, delayMs = 250): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    const gen = generation;
    refreshTimer = setTimeout(async () => {
      try {
        const fresh = await api.runs.get(id);
        if (gen !== generation || !live.value) return;
        run.value = fresh;
        for (const s of fresh.steps) {
          const step = live.value.steps[s.nodeId];
          if (step && s.input !== null) step.input = s.input;
        }
        // Si el servidor ya la da por terminada, su versión es la definitiva.
        if (!isActiveStatus(fresh.status) && isActiveStatus(live.value.status)) {
          const next = fromRun(fresh, live.value.events);
          // Un paso cancelado o fallido a medias no guarda salida: se conserva lo que ya se había visto en directo.
          for (const [nodeId, step] of Object.entries(next.steps)) {
            const seen = live.value.steps[nodeId];
            if (seen && step.output === null) {
              step.streamText = seen.streamText;
              step.thinkingText = seen.thinkingText;
            }
          }
          live.value = reactive(next) as RunLive;
          close();
        }
      } catch {
        /* se reintentará con el siguiente evento */
      }
    }, delayMs);
  }

  async function load(id: string): Promise<void> {
    const gen = ++generation;
    close();
    loading.value = true;
    error.value = null;
    try {
      const fetched = await api.runs.get(id);
      if (gen !== generation) return;
      run.value = fetched;
      if (!isActiveStatus(fetched.status)) {
        const events = await api.runs.events(id);
        if (gen !== generation) return;
        live.value = reactive(fromRun(fetched, events)) as RunLive;
        return;
      }
      // En curso: se parte de cero y se reproducen todos los eventos (historial + directo) por SSE.
      const state = reactive(blankFromRun(fetched)) as RunLive;
      for (const s of fetched.steps) if (s.input !== null) state.steps[s.nodeId].input = s.input;
      live.value = state;
      source = new EventSource(`/api/runs/${id}/stream?after=0`);
      source.addEventListener('run-event', (msg) => {
        if (gen !== generation) return;
        const ev = JSON.parse((msg as MessageEvent).data) as RunEvent;
        applyEvent(state, ev);
        if (ev.type === 'step.started' || ev.type === 'step.finished') scheduleRefresh(id);
        if (ev.type === 'run.finished') {
          source?.close();
          source = null;
          scheduleRefresh(id, 50);
        }
      });
    } catch (err) {
      if (gen !== generation) return;
      error.value = errorText(err);
      run.value = null;
      live.value = null;
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  watch(
    runId,
    (id) => {
      if (id) void load(id);
      else {
        generation++;
        close();
        run.value = null;
        live.value = null;
      }
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    generation++;
    close();
  });

  const usage = computed(() => (live.value ? totalUsage(live.value) : null));
  const isActive = computed(() => (live.value ? isActiveStatus(live.value.status) : false));
  const reload = () => (runId.value ? load(runId.value) : Promise.resolve());

  return { run, live, loading, error, usage, isActive, reload };
}
