// Composable que mantiene el estado de una ejecución al día mediante SSE.
import type { Run, RunEvent } from '@shared/types';
import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue';
import { api, errorText } from './api';
import { isActiveStatus } from './format';
import { appendActivity, applyEvent, fromRun, prependActivity, totalUsage, type RunLive } from './run-state';

/** Eventos que se piden de una vez para el registro de actividad (los más recientes al abrir; después, hacia atrás). */
export const EVENTS_PAGE = 200;

export function useRunStream(runId: Ref<string | null>) {
  const run = ref<Run | null>(null);
  const live = ref<RunLive | null>(null);
  const loading = ref(false);
  const loadingOlder = ref(false);
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
          if (!step) continue;
          if (s.input !== null) step.input = s.input;
          // La salida de un paso ya terminado puede no haber llegado por el flujo (los eventos del historial no la repiten).
          if (s.output !== null && step.output === null && step.status === s.status) step.output = s.output;
        }
        if (fresh.output !== null && live.value.output === null && live.value.status === fresh.status) live.value.output = fresh.output;
        // Si el servidor ya la da por terminada, su versión es la definitiva.
        if (!isActiveStatus(fresh.status) && isActiveStatus(live.value.status)) {
          const seen = live.value.lastSeq;
          const next = fromRun(fresh, live.value.activity);
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
          // Lo que ocurrió con el flujo cortado no llegó al registro de actividad: se pide solo ese tramo.
          void catchUp(id, gen, seen);
        }
      } catch {
        /* se reintentará con el siguiente evento */
      }
    }, delayMs);
  }

  /** Añade al registro de actividad los eventos guardados posteriores a `after` (el estado de los pasos ya es el del servidor). */
  async function catchUp(id: string, gen: number, after: number): Promise<void> {
    try {
      for (;;) {
        const events = await api.runs.events(id, { after, limit: EVENTS_PAGE });
        if (gen !== generation || !live.value) return;
        for (const ev of events) appendActivity(live.value.activity, ev);
        if (events.length < EVENTS_PAGE) return;
        after = events[events.length - 1].seq!;
      }
    } catch {
      /* el registro queda incompleto hasta la próxima carga; el estado mostrado sí es el definitivo */
    }
  }

  /** Carga la página de eventos anterior a los que ya están en el registro de actividad. */
  async function loadOlder(): Promise<void> {
    const id = runId.value;
    const gen = generation;
    if (!id || !live.value || loadingOlder.value || live.value.activity.firstSeq <= 1) return;
    loadingOlder.value = true;
    try {
      const events = await api.runs.events(id, { before: live.value.activity.firstSeq, limit: EVENTS_PAGE });
      if (gen !== generation || !live.value) return;
      prependActivity(live.value.activity, events);
      // Una página incompleta es la primera de la ejecución: no queda nada más antiguo.
      if (events.length < EVENTS_PAGE) live.value.activity.firstSeq = Math.min(live.value.activity.firstSeq, 1);
    } finally {
      loadingOlder.value = false;
    }
  }

  async function load(id: string): Promise<void> {
    const gen = ++generation;
    close();
    loading.value = true;
    error.value = null;
    try {
      // El servidor entrega el estado de los pasos ya calculado hasta `lastSeq`, también con la ejecución en curso:
      // no se reproduce el historial. Del registro de actividad se trae solo la página más reciente.
      const fetched = await api.runs.get(id);
      if (gen !== generation) return;
      const recent = fetched.lastSeq ? await api.runs.events(id, { before: fetched.lastSeq + 1, limit: EVENTS_PAGE }) : [];
      if (gen !== generation) return;
      run.value = fetched;
      const state = reactive(fromRun(fetched)) as RunLive;
      prependActivity(state.activity, recent);
      if (recent.length < EVENTS_PAGE && state.activity.firstSeq > 1) state.activity.firstSeq = 1;
      live.value = state;
      if (!isActiveStatus(fetched.status)) return;
      // En curso: el flujo continúa justo después del último evento que ya recoge ese estado.
      source = new EventSource(`/api/runs/${id}/stream?after=${fetched.lastSeq}`);
      // Si el flujo se corta (el servidor cae o la red falla) el navegador lo reintenta solo, pero una ejecución que
      // termine mientras tanto no enviaría ya ningún evento: se consulta su estado para no quedarse «en curso».
      source.onerror = () => {
        if (gen === generation) scheduleRefresh(id, 500);
      };
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
  /** Quedan eventos más antiguos en el servidor que no están en el registro de actividad. */
  const hasOlder = computed(() => (live.value ? live.value.activity.firstSeq > 1 : false));
  const reload = () => (runId.value ? load(runId.value) : Promise.resolve());

  return { run, live, loading, error, usage, isActive, reload, hasOlder, loadingOlder, loadOlder };
}
