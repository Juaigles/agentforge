// Estado en vivo de las ejecuciones: escucha el canal SSE global y avisa a las vistas de cada cambio.
import type { RunSummary } from '@shared/types';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { isActiveStatus } from '@/lib/format';
import { useUi } from './ui';

export const useRuns = defineStore('runs', () => {
  /** Ejecuciones vistas en esta sesión (id → último estado conocido). */
  const known = shallowRef(new Map<string, RunSummary>());
  /** Se incrementa con cada cambio; las vistas lo observan para refrescar sus datos. */
  const version = ref(0);
  const lastChanged = shallowRef<RunSummary | null>(null);
  const connected = ref(false);
  /** Ejecución que el usuario está mirando ahora mismo (no se le avisa de su final con un toast). */
  const watching = ref<string | null>(null);
  let source: EventSource | null = null;

  const active = computed(() => [...known.value.values()].filter((r) => isActiveStatus(r.status)));

  function apply(run: RunSummary, notify = true): void {
    const previous = known.value.get(run.id);
    const next = new Map(known.value);
    next.set(run.id, run);
    known.value = next;
    lastChanged.value = run;
    version.value++;
    if (!notify || !previous || !isActiveStatus(previous.status) || isActiveStatus(run.status)) return;
    if (watching.value === run.id) return;
    const ui = useUi();
    const action = { label: 'Ver', to: `/runs/${run.id}` };
    if (run.status === 'completed') ui.success(`«${run.name}» ha terminado.`, action);
    else if (run.status === 'failed') ui.toast('danger', `«${run.name}» ha fallado.`, action);
  }

  /** Registra ejecuciones obtenidas por REST (p. ej. las activas al cargar la página). */
  function seed(runs: RunSummary[]): void {
    const next = new Map(known.value);
    for (const r of runs) next.set(r.id, r);
    known.value = next;
  }

  function forget(id: string): void {
    const next = new Map(known.value);
    next.delete(id);
    known.value = next;
    version.value++;
  }

  function connect(): void {
    if (source) return;
    source = new EventSource('/api/stream/runs');
    source.onopen = () => (connected.value = true);
    source.onerror = () => (connected.value = false); // EventSource reconecta solo
    source.addEventListener('run', (ev) => apply(JSON.parse((ev as MessageEvent).data) as RunSummary));
  }

  return { known, version, lastChanged, connected, watching, active, apply, seed, forget, connect };
});
