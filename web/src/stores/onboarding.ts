// Estado del recorrido guiado: el progreso (guardado en el navegador), el paso actual según la piel y la escucha de
// la ejecución del workflow de bienvenida a través del store de ejecuciones (lo que la hace avanzar sola).
// Las reglas viven en lib/onboarding.ts; aquí solo se conectan con Vue, la API y los demás stores.
import type { RunStatus } from '@shared/types';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '@/lib/api';
import * as tour from '@/lib/onboarding';
import { skin } from '@/lib/skin';
import { useCatalog } from './catalog';
import { useRuns } from './runs';

export const useOnboarding = defineStore('onboarding', () => {
  const runs = useRuns();
  const catalog = useCatalog();

  const progress = ref<tour.TourProgress>(tour.loadProgress());
  watch(progress, (p) => tour.saveProgress(p));

  /** Preparando el workflow de bienvenida (petición en curso) y si falló. */
  const preparing = ref(false);
  const prepareFailed = ref(false);

  const steps = computed(() => tour.stepsFor(skin.value));
  const index = computed(() => tour.currentIndex(progress.value, skin.value));
  const step = computed(() => steps.value[index.value]);
  const active = computed(() => progress.value.status === 'active');
  const open = computed(() => active.value && progress.value.open);
  const facts = computed(() => progress.value.facts);
  /** Hay al menos un proveedor que responde (o aún no se sabe: no se alarma antes de tiempo). */
  const modelKnown = computed(() => catalog.health.length > 0 || (catalog.loaded && catalog.providers.length === 0));
  const modelReady = computed(() => catalog.health.some((h) => h.ok));

  type Missing = (s: tour.TourStep) => boolean;

  function startTour(): void {
    progress.value = tour.start(progress.value);
  }
  function next(isMissing?: Missing): void {
    progress.value = tour.move(progress.value, skin.value, 1, isMissing);
  }
  function back(isMissing?: Missing): void {
    progress.value = tour.move(progress.value, skin.value, -1, isMissing);
  }
  function goTo(id: string): void {
    if (tour.TOUR_STEPS.some((s) => s.id === id)) progress.value = { ...progress.value, stepId: id };
  }
  const close = () => (progress.value = tour.close(progress.value));
  const dismiss = () => (progress.value = tour.dismiss(progress.value));
  const finish = () => (progress.value = tour.complete(progress.value));
  const setTypewriter = (on: boolean) => (progress.value = { ...progress.value, typewriter: on });

  /** Obtiene (o crea) el workflow de bienvenida y lo recuerda. Devuelve su id o null si no se pudo. */
  async function ensureWorkflow(): Promise<string | null> {
    if (progress.value.workflowId && catalog.workflows.some((w) => w.id === progress.value.workflowId)) return progress.value.workflowId;
    preparing.value = true;
    prepareFailed.value = false;
    try {
      // Idempotente: lo crea si falta (o se borró) y, si ya existe, devuelve el mismo.
      const id: string | null = (await api.welcome()).workflowId || null;
      if (id) {
        progress.value = { ...progress.value, workflowId: id };
        // Que aparezca en el catálogo (lista de workflows, paleta de subworkflows) sin recargar la página.
        if (!catalog.workflows.some((w) => w.id === id)) void catalog.reload().catch(() => undefined);
      } else prepareFailed.value = true;
      return id;
    } catch {
      prepareFailed.value = true;
      return null;
    } finally {
      preparing.value = false;
    }
  }

  function observe(run: { id: string; workflowId: string | null; status: RunStatus }): void {
    const next = tour.observeRun(progress.value, skin.value, run);
    if (next !== progress.value) progress.value = next;
  }

  /** Al reanudar (p. ej. tras recargar la página) se pregunta por la ejecución del recorrido: el canal en vivo no repite lo pasado. */
  async function syncRun(): Promise<void> {
    const id = progress.value.runId;
    if (!active.value || !id || progress.value.facts.runFinished) return;
    try {
      const run = await api.runs.get(id);
      observe({ id: run.id, workflowId: run.workflowId, status: run.status });
    } catch {
      /* la ejecución ya no existe o no hay conexión: el recorrido sigue y se puede saltar */
    }
  }

  watch(
    () => runs.lastChanged,
    (run) => {
      if (run && active.value) observe(run);
    },
  );

  return {
    progress,
    preparing,
    prepareFailed,
    steps,
    index,
    step,
    active,
    open,
    facts,
    modelKnown,
    modelReady,
    startTour,
    next,
    back,
    goTo,
    close,
    dismiss,
    finish,
    setTypewriter,
    ensureWorkflow,
    observe,
    syncRun,
  };
});
