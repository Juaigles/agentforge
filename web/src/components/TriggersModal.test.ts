// @vitest-environment jsdom
// Diálogo de disparadores de un workflow contra la API real (ver src/test/harness.ts). El único doble es el proveedor LLM.
import type { Trigger, TriggerInput } from '@shared/types';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Router } from 'vue-router';
import { edges, node, workflow } from '../../../server/test/helpers';
import { useUi } from '@/stores/ui';
import { freshPinia, setTouchDevice, startApi, testRouter, until, type TestApi } from '@/test/harness';
import TriggersModal from './TriggersModal.vue';
import UiHost from './UiHost.vue';

let api: TestApi;
let wrapper: VueWrapper;
let host: VueWrapper;
let router: Router;
let workflowId: string;
const WF_NAME = 'Informe diario';

/** Un workflow válido (entrada → salida) para colgar disparadores y poder lanzarlo de verdad. */
function createWorkflow(name = WF_NAME): string {
  return api.ctx.store.createWorkflow({
    ...workflow([node('entrada', 'input'), node('salida', 'output', { template: '{{entrada}}' })], edges('entrada>salida')),
    name,
  }).id;
}

const input = (patch: Partial<TriggerInput>): TriggerInput => ({
  kind: 'interval',
  name: '',
  intervalMinutes: 60,
  time: null,
  weekdays: [],
  cron: null,
  timezone: null,
  input: '',
  enabled: true,
  ...patch,
});
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
const addTrigger = (patch: Partial<TriggerInput>, secret?: string): Trigger =>
  api.ctx.store.createTrigger(workflowId, input(patch), patch.enabled === false || patch.kind === 'webhook' ? null : inOneHour(), secret);

async function open(props: { defaultInput?: string } = {}): Promise<void> {
  const pinia = freshPinia();
  router = testRouter();
  await router.push('/');
  // UiHost pinta los avisos y el diálogo de confirmación, igual que en la aplicación.
  host = mount(UiHost, { global: { plugins: [pinia, router] }, attachTo: document.body });
  wrapper = mount(TriggersModal, { props: { workflowId, workflowName: WF_NAME, ...props }, global: { plugins: [pinia, router] }, attachTo: document.body });
  await until(() => !document.body.querySelector('.skeleton'));
}

// El diálogo se teletransporta al <body>: se busca ahí.
const body = () => document.body;
const el = (selector: string) => new DOMWrapper(body().querySelector(selector)!);
const dialog = () => body().querySelector<HTMLElement>('[role="dialog"]')!;
const buttons = (scope: ParentNode = body()) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string, scope: ParentNode = body()) =>
  buttons(scope).find((b) => b.textContent?.includes(text) || b.getAttribute('aria-label')?.includes(text));
const click = async (text: string, scope: ParentNode = body()) => {
  const found = button(text, scope);
  if (!found) throw new Error(`No hay botón «${text}»`);
  await new DOMWrapper(found).trigger('click');
};
const items = () => [...body().querySelectorAll<HTMLElement>('ul[aria-label="Disparadores del workflow"] > li')];
const toasts = () => useUi().toasts.map((t) => t.message);
const alerts = () => [...body().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.trim() ?? '');
const text = () => body().textContent ?? '';
const triggers = () => api.ctx.store.listTriggers(workflowId);
const dayButton = (name: string) => body().querySelector<HTMLButtonElement>(`.days button[aria-label="${name}"]`)!;
const previewItems = () => body().querySelectorAll('.preview li').length;

/** Confirma (o rechaza) el diálogo de confirmación que ha abierto una acción. */
async function answerConfirm(title: string, label: string | null): Promise<void> {
  await until(() => Boolean(body().querySelector(`[role="dialog"][aria-label="${title}"]`)));
  const confirmDialog = body().querySelector<HTMLElement>(`[role="dialog"][aria-label="${title}"]`)!;
  await click(label ?? 'Cancelar', confirmDialog);
  await flushPromises();
}

beforeEach(async () => {
  setTouchDevice(false);
  api = await startApi();
  workflowId = createWorkflow();
});
afterEach(async () => {
  wrapper?.unmount();
  host?.unmount();
  document.body.innerHTML = '';
  await api.close();
});

describe('TriggersModal: la lista', () => {
  it('sin disparadores explica que el workflow solo se ejecuta cuando lo lanzas tú', async () => {
    await open();
    expect(dialog().getAttribute('aria-label')).toBe('Disparadores de «Informe diario»');
    expect(text()).toContain('Este workflow todavía no tiene disparadores: solo se ejecuta cuando lo lanzas tú.');
    expect(items()).toHaveLength(0);
    expect(button('Añadir disparador')).toBeDefined();
  });

  it('con disparadores existentes enseña cada uno en lenguaje natural, con su estado y la dirección del webhook', async () => {
    const every15 = addTrigger({ intervalMinutes: 15 });
    const daily = addTrigger({
      kind: 'daily',
      name: 'Resumen semanal',
      time: '07:45',
      weekdays: [1, 2, 3, 4, 5],
      timezone: 'Europe/Madrid',
      intervalMinutes: null,
    });
    const hook = addTrigger({ kind: 'webhook', name: 'Alertas', intervalMinutes: null }, 'whsec_guardado');
    addTrigger({ kind: 'cron', cron: '0 9 * * 1-5', intervalMinutes: null, enabled: false });
    await open();

    const rows = items();
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain('cada 15 min');
    expect(rows[0].textContent).toContain('Próxima');
    expect(rows[0].textContent).toContain('Todavía ninguna');
    expect(rows[0].textContent).not.toContain('Sin fecha');
    expect(rows[1].textContent).toContain('Resumen semanal');
    expect(rows[1].textContent).toContain('de lunes a viernes a las 07:45 (Europe/Madrid)');
    expect(rows[2].textContent).toContain('Alertas');
    expect(rows[2].textContent).toContain(`POST ${window.location.origin}/api/hooks/${hook.id}`);
    expect(rows[2].textContent).not.toContain('Próxima'); // un webhook no tiene horario
    expect(rows[2].textContent).not.toContain('whsec_guardado'); // el secreto guardado no se vuelve a enseñar
    expect(rows[2].textContent).toContain('Nuevo secreto');
    expect(rows[0].textContent).not.toContain('Nuevo secreto'); // solo los webhooks tienen secreto
    expect(rows[3].textContent).toContain('En pausa');
    expect((rows[3].querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect((rows[0].querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect(every15.id).not.toBe(daily.id);
  });

  it('enlaza la última ejecución de un disparador que ya se lanzó', async () => {
    const trigger = addTrigger({ intervalMinutes: 30 });
    const run = api.ctx.runs.startWorkflowRun(api.ctx.store.getWorkflow(workflowId)!, 'x', { scheduled: true, triggerKind: 'interval' });
    await api.ctx.runs.waitFor(run.id);
    api.ctx.store.updateTriggerState(trigger.id, { lastRunAt: new Date().toISOString(), lastRunId: run.id });
    await open();
    const link = items()[0].querySelector('.state a')!;
    expect(link.getAttribute('href')).toBe(`/runs/${run.id}`);
    expect(items()[0].textContent).not.toContain('Todavía ninguna');
  });

  it('muestra por qué no se pudo lanzar la última ocasión', async () => {
    const trigger = addTrigger({ intervalMinutes: 30 });
    api.ctx.store.updateTriggerState(trigger.id, { lastError: 'No se pudo lanzar: el workflow tiene errores.' });
    await open();
    expect(items()[0].textContent).toContain('No se pudo lanzar: el workflow tiene errores.');
  });

  it('avisa al padre de los disparadores cargados', async () => {
    addTrigger({ intervalMinutes: 15 });
    await open();
    const emitted = wrapper.emitted('changed')!;
    expect(emitted).toHaveLength(1);
    expect((emitted[0][0] as Trigger[]).map((t) => t.intervalMinutes)).toEqual([15]);
  });

  it('si el workflow ya no existe lo dice y no deja añadir disparadores', async () => {
    workflowId = 'wf_inexistente';
    await open();
    expect(alerts().join(' ')).toContain('Workflow no encontrado.');
    expect(button('Añadir disparador')!.disabled).toBe(true);
  });
});

describe('TriggersModal: alta de disparadores', () => {
  it('cada cierto tiempo: valida el intervalo, enseña la vista previa y guarda en el servidor', async () => {
    await open({ defaultInput: 'dato por defecto' });
    await click('Añadir disparador');
    expect(dialog().getAttribute('aria-label')).toBe('Nuevo disparador de «Informe diario»');
    expect((el('#trg-input').element as HTMLTextAreaElement).value).toBe('dato por defecto'); // la entrada propuesta

    // 0 minutos no vale: se dice en el campo y no se puede crear.
    await el('#trg-every').setValue('0');
    expect(alerts().join(' ')).toContain('Indica un número entero de al menos 1 minuto.');
    expect(button('Crear disparador')!.disabled).toBe(true);
    expect(el('#trg-every').attributes('aria-invalid')).toBe('true');
    // Más de 30 días tampoco.
    await el('#trg-every').setValue('31');
    await el('select[aria-label="Unidad del intervalo"]').setValue('days');
    expect(alerts().join(' ')).toContain('El intervalo máximo son 30 días.');
    expect(button('Crear disparador')!.disabled).toBe(true);
    expect(triggers()).toHaveLength(0);

    await el('#trg-every').setValue('2');
    await el('select[aria-label="Unidad del intervalo"]').setValue('hours');
    await el('#trg-input').setValue('informe de la mañana');
    await until(() => previewItems() === 5); // las próximas ocasiones las calcula el servidor
    expect(text()).toContain('Próximas ejecuciones');

    const before = Date.now();
    await click('Crear disparador');
    await until(() => triggers().length === 1);
    const [saved] = triggers();
    expect(saved).toMatchObject({ kind: 'interval', intervalMinutes: 120, input: 'informe de la mañana', enabled: true, lastRunId: null, name: '' });
    expect(Math.abs(Date.parse(saved.nextRunAt!) - (before + 120 * 60_000))).toBeLessThan(15_000);
    await until(() => toasts().includes('«Informe diario» se ejecutará cada 2 h.'));
    // Vuelve a la lista con el nuevo disparador.
    await until(() => items().length === 1);
    expect(items()[0].textContent).toContain('cada 2 h');
  });

  it('días y hora con zona horaria: una zona desconocida la rechaza el servidor y se dice en su campo', async () => {
    await open();
    await click('Añadir disparador');
    await click('Días y hora');
    await el('#trg-time').setValue('07:45');
    await new DOMWrapper(dayButton('lunes')).trigger('click');
    await new DOMWrapper(dayButton('viernes')).trigger('click');
    expect(dayButton('lunes').getAttribute('aria-pressed')).toBe('true');
    expect(dayButton('martes').getAttribute('aria-pressed')).toBe('false');
    expect(text()).toContain('Solo los días marcados.');
    await el('#trg-name').setValue('Resumen semanal');
    await el('#trg-zone').setValue('Marte/Olympus');

    await click('Crear disparador');
    await until(() => alerts().some((a) => a.includes('no es una zona horaria conocida')));
    expect(el('#trg-zone').attributes('aria-invalid')).toBe('true');
    expect(triggers()).toHaveLength(0);
    expect(dialog().getAttribute('aria-label')).toBe('Nuevo disparador de «Informe diario»'); // sigue en el formulario

    await el('#trg-zone').setValue('Europe/Madrid');
    await until(() => text().includes('Próximas ejecuciones (Europe/Madrid)'));
    expect(previewItems()).toBe(5);
    expect(alerts()).toHaveLength(0); // el error de la zona anterior desaparece al corregirla
    await click('Crear disparador');
    await until(() => triggers().length === 1);
    expect(triggers()[0]).toMatchObject({
      kind: 'daily',
      time: '07:45',
      weekdays: [1, 5],
      timezone: 'Europe/Madrid',
      name: 'Resumen semanal',
      intervalMinutes: null,
    });
    expect(triggers()[0].nextRunAt).not.toBeNull();
    await until(() => toasts().includes('«Informe diario» se ejecutará lun y vie a las 07:45 (Europe/Madrid).'));
  });

  it('sin marcar ningún día se ejecuta todos los días, y una hora no válida no se deja guardar', async () => {
    await open();
    await click('Añadir disparador');
    await click('Días y hora');
    expect(text()).toContain('Sin marcar ninguno, se ejecuta todos los días.');

    await el('#trg-time').setValue('');
    expect(alerts().join(' ')).toContain('Indica una hora válida (HH:MM).');
    expect(button('Crear disparador')!.disabled).toBe(true);
    expect(triggers()).toHaveLength(0);

    await el('#trg-time').setValue('18:30');
    await click('Crear disparador');
    await until(() => triggers().length === 1);
    expect(triggers()[0]).toMatchObject({ kind: 'daily', time: '18:30', weekdays: [], timezone: null });
    await until(() => toasts().includes('«Informe diario» se ejecutará cada día a las 18:30.'));
  });

  it('cron: una expresión inválida se señala con el motivo del servidor y no se guarda; una válida enseña las próximas ejecuciones', async () => {
    await open();
    await click('Añadir disparador');
    await click('Cron');

    await el('#trg-cron').setValue('');
    expect(alerts().join(' ')).toContain('Escribe la expresión cron.');
    expect(button('Crear disparador')!.disabled).toBe(true);

    await el('#trg-cron').setValue('cada lunes');
    await until(() => alerts().some((a) => a.includes('cinco campos'))); // el motivo lo da el servidor al calcular la vista previa
    expect(previewItems()).toBe(0);
    await click('Crear disparador');
    await until(() => el('#trg-cron').attributes('aria-invalid') === 'true' && !button('Crear disparador')!.disabled);
    await flushPromises();
    expect(triggers()).toHaveLength(0);

    // Una expresión que nunca se cumple (30 de febrero) también la rechaza el servidor.
    await el('#trg-cron').setValue('0 0 30 2 *');
    await until(() => alerts().some((a) => a.includes('no se cumple nunca')));
    expect(alerts().join(' ')).not.toContain('cinco campos'); // el error anterior ya no vale
    expect(triggers()).toHaveLength(0);

    await el('#trg-cron').setValue('*/5 * * * *');
    await until(() => previewItems() === 5);
    expect(alerts()).toHaveLength(0);
    await click('Crear disparador');
    await until(() => triggers().length === 1);
    expect(triggers()[0]).toMatchObject({ kind: 'cron', cron: '*/5 * * * *', timezone: null });
    await until(() => toasts().includes('«Informe diario» se ejecutará según el cron «*/5 * * * *».'));
  });

  it('webhook: el servidor crea el secreto, se enseña una sola vez y no vuelve a aparecer', async () => {
    await open();
    await click('Añadir disparador');
    await click('Webhook');
    await el('#trg-input').setValue('Aviso recibido: {{body}}');
    await el('#trg-name').setValue('Alertas');
    await click('Crear disparador');
    await until(() => triggers().length === 1);
    await until(() => Boolean(body().querySelector('[data-testid="webhook-secret"]')) && items().length === 1);

    const [hook] = triggers();
    expect(hook).toMatchObject({ kind: 'webhook', name: 'Alertas', input: 'Aviso recibido: {{body}}', nextRunAt: null });
    const secret = body().querySelector('[data-testid="webhook-secret"]')!.textContent!.trim();
    expect(secret).toMatch(/^whsec_/);
    expect(api.ctx.store.getTriggerSecret(hook.id)).toBe(secret); // es el que guardó el servidor
    expect(JSON.stringify(hook)).not.toContain(secret); // la lista nunca lo lleva
    await until(() => toasts().includes('Webhook creado. Copia ahora su secreto: no se volverá a mostrar.'));
    expect(text()).toContain(`POST ${window.location.origin}/api/hooks/${hook.id}`);

    // Es el secreto de verdad: otro programa puede lanzar el workflow con él.
    const call = (token: string) =>
      fetch(`/api/hooks/${hook.id}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` }, body: 'servidor caído' });
    expect((await call('whsec_incorrecto')).status).toBe(401);
    const ok = await call(secret);
    expect(ok.status).toBe(202);
    const { runId } = (await ok.json()) as { runId: string };
    await api.ctx.runs.waitFor(runId);
    expect(api.ctx.store.getRun(runId)).toMatchObject({ input: 'Aviso recibido: servidor caído', status: 'completed' });

    // «Ya lo he guardado» lo oculta; al reabrir el diálogo ya no está.
    await click('Ya lo he guardado');
    expect(body().querySelector('[data-testid="webhook-secret"]')).toBeNull();
    wrapper.unmount();
    wrapper = mount(TriggersModal, { props: { workflowId, workflowName: WF_NAME }, global: { plugins: [freshPinia(), router] }, attachTo: document.body });
    await until(() => items().length === 1);
    expect(body().querySelector('[data-testid="webhook-secret"]')).toBeNull();
    expect(text()).not.toContain(secret);
  });

  it('el servidor limita los disparadores por workflow y el diálogo lo dice sin crear el siguiente', async () => {
    for (let i = 1; i <= 20; i++) addTrigger({ intervalMinutes: i, name: `Disparador ${i}` });
    await open();
    expect(items()).toHaveLength(20);
    await click('Añadir disparador');
    await el('#trg-name').setValue('El que sobra');
    await click('Crear disparador');
    await until(() => alerts().some((a) => a.includes('como máximo 20 disparadores')));
    expect(triggers()).toHaveLength(20);
    expect(triggers().some((t) => t.name === 'El que sobra')).toBe(false);
    expect(dialog().getAttribute('aria-label')).toBe('Nuevo disparador de «Informe diario»');
    // «Volver» devuelve a la lista sin cambios.
    await click('Volver');
    expect(items()).toHaveLength(20);
  });

  it('«Volver» abandona el formulario sin guardar nada', async () => {
    await open();
    await click('Añadir disparador');
    await el('#trg-every').setValue('5');
    await click('Volver');
    expect(text()).toContain('Este workflow todavía no tiene disparadores');
    expect(triggers()).toHaveLength(0);
  });
});

describe('TriggersModal: editar, pausar y reanudar', () => {
  it('editar carga los valores guardados, no deja cambiar el tipo y guarda los cambios', async () => {
    const trigger = addTrigger({ intervalMinutes: 120, name: 'Cada dos horas', input: 'hola' });
    await open();
    await click('Editar');
    expect(dialog().getAttribute('aria-label')).toBe('Editar disparador');
    expect((el('#trg-every').element as HTMLInputElement).value).toBe('2');
    expect((el('select[aria-label="Unidad del intervalo"]').element as HTMLSelectElement).value).toBe('hours');
    expect((el('#trg-name').element as HTMLInputElement).value).toBe('Cada dos horas');
    expect((el('#trg-input').element as HTMLTextAreaElement).value).toBe('hola');
    expect(body().querySelector('[role="radio"]')).toBeNull(); // el tipo no se cambia al editar

    await el('#trg-every').setValue('30');
    await el('select[aria-label="Unidad del intervalo"]').setValue('minutes');
    await click('Guardar disparador');
    await until(() => api.ctx.store.getTrigger(trigger.id)!.intervalMinutes === 30);
    expect(api.ctx.store.getTrigger(trigger.id)).toMatchObject({ kind: 'interval', name: 'Cada dos horas', input: 'hola', enabled: true });
    expect(Math.abs(Date.parse(api.ctx.store.getTrigger(trigger.id)!.nextRunAt!) - (Date.now() + 30 * 60_000))).toBeLessThan(15_000);
    await until(() => toasts().includes('Disparador guardado.'));
    await until(() => items().length === 1 && items()[0].textContent!.includes('cada 30 min'));
  });

  it('editar un disparador con horario recupera días, hora y zona; guardarlo desactivado lo deja en pausa', async () => {
    const trigger = addTrigger({ kind: 'daily', time: '07:45', weekdays: [1, 5], timezone: 'Europe/Madrid', intervalMinutes: null });
    await open();
    await click('Editar');
    expect((el('#trg-time').element as HTMLInputElement).value).toBe('07:45');
    expect((el('#trg-zone').element as HTMLInputElement).value).toBe('Europe/Madrid');
    expect(dayButton('lunes').getAttribute('aria-pressed')).toBe('true');
    expect(dayButton('miércoles').getAttribute('aria-pressed')).toBe('false');

    await new DOMWrapper(dayButton('miércoles')).trigger('click');
    await el('input.switch[type="checkbox"]').setValue(false); // «Disparador activo»
    await click('Guardar disparador');
    await until(() => api.ctx.store.getTrigger(trigger.id)!.weekdays.length === 3);
    expect(api.ctx.store.getTrigger(trigger.id)).toMatchObject({ weekdays: [1, 3, 5], enabled: false, nextRunAt: null, timezone: 'Europe/Madrid' });
    await until(() => toasts().includes('Disparador guardado, pero desactivado.'));
  });

  it('editar con una zona horaria inválida la rechaza en su campo y no toca lo guardado', async () => {
    const trigger = addTrigger({ kind: 'cron', cron: '0 9 * * 1-5', intervalMinutes: null });
    await open();
    await click('Editar');
    expect((el('#trg-cron').element as HTMLInputElement).value).toBe('0 9 * * 1-5');
    await el('#trg-zone').setValue('Atlantida/Central');
    await click('Guardar disparador');
    await until(() => alerts().some((a) => a.includes('no es una zona horaria conocida')));
    expect(api.ctx.store.getTrigger(trigger.id)!.timezone).toBeNull();
  });

  it('el interruptor pausa un disparador (sin próxima ocasión) y lo reanuda (con una nueva)', async () => {
    const trigger = addTrigger({ intervalMinutes: 15, name: 'Cada 15' });
    await open();
    const toggle = () => items()[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle().getAttribute('aria-label')).toBe('Disparador activo: Cada 15');

    await new DOMWrapper(toggle()).trigger('change'); // el cambio lo lanza el clic del usuario
    await until(() => !api.ctx.store.getTrigger(trigger.id)!.enabled);
    expect(api.ctx.store.getTrigger(trigger.id)).toMatchObject({ enabled: false, nextRunAt: null, intervalMinutes: 15, name: 'Cada 15' });
    await until(() => items()[0].textContent!.includes('En pausa'));
    expect(toggle().checked).toBe(false);

    await new DOMWrapper(toggle()).trigger('change');
    await until(() => api.ctx.store.getTrigger(trigger.id)!.enabled);
    const resumed = api.ctx.store.getTrigger(trigger.id)!;
    expect(Math.abs(Date.parse(resumed.nextRunAt!) - (Date.now() + 15 * 60_000))).toBeLessThan(15_000);
    await until(() => !items()[0].textContent!.includes('En pausa'));
    expect(toggle().checked).toBe(true);
  });

  it('si otro usuario borró el disparador, la acción dice que ya no existe y refresca la lista al volver', async () => {
    const trigger = addTrigger({ intervalMinutes: 15 });
    await open();
    api.ctx.store.deleteTrigger(trigger.id);
    await new DOMWrapper(items()[0].querySelector('input[type="checkbox"]')!).trigger('change');
    await until(() => alerts().some((a) => a.includes('Disparador no encontrado.')));
    expect(triggers()).toHaveLength(0);
  });
});

describe('TriggersModal: ejecutar ahora', () => {
  it('lanza una ejecución real con la entrada guardada, cierra el diálogo y lleva a ella sin mover la siguiente ocasión', async () => {
    const trigger = addTrigger({ intervalMinutes: 60, input: 'informe de la mañana' });
    const nextBefore = api.ctx.store.getTrigger(trigger.id)!.nextRunAt;
    await open();
    expect(api.ctx.store.listRuns({ workflowId }).items).toHaveLength(0);

    await click('Ejecutar ahora');
    await until(() => api.ctx.store.listRuns({ workflowId }).items.length === 1);
    const [summary] = api.ctx.store.listRuns({ workflowId }).items;
    await api.ctx.runs.waitFor(summary.id);
    const run = api.ctx.store.getRun(summary.id)!;
    expect(run).toMatchObject({ input: 'informe de la mañana', status: 'completed', scheduled: true, triggerKind: 'interval', workflowId });
    expect(run.output).toBe('informe de la mañana');

    await until(() => router.currentRoute.value.path === `/runs/${run.id}`);
    expect(wrapper.emitted('close')).toHaveLength(1);
    const after = api.ctx.store.getTrigger(trigger.id)!;
    expect(after.lastRunId).toBe(run.id);
    expect(after.lastError).toBeNull();
    expect(after.nextRunAt).toBe(nextBefore);
  });

  it('un webhook lanzado a mano no cuenta como ejecución programada', async () => {
    addTrigger({ kind: 'webhook', intervalMinutes: null, input: 'prueba manual' }, 'whsec_x');
    await open();
    await click('Ejecutar ahora');
    await until(() => api.ctx.store.listRuns({ workflowId }).items.length === 1);
    const [summary] = api.ctx.store.listRuns({ workflowId }).items;
    await api.ctx.runs.waitFor(summary.id);
    expect(api.ctx.store.getRun(summary.id)).toMatchObject({ scheduled: false, triggerKind: 'webhook', input: 'prueba manual' });
  });

  it('si el workflow tiene errores no se lanza nada, se explica y se guarda el motivo en el disparador', async () => {
    const broken = api.ctx.store.createWorkflow({
      ...workflow([node('entrada', 'input'), node('paso', 'agent', { agentId: 'agt_que_no_existe', prompt: '{{entrada}}' })], edges('entrada>paso')),
      name: 'Roto',
    });
    workflowId = broken.id;
    const trigger = addTrigger({ intervalMinutes: 60 });
    await open();
    await click('Ejecutar ahora');
    await until(() => alerts().some((a) => a.includes('No se pudo lanzar')));
    expect(api.ctx.store.listRuns({ workflowId }).items).toHaveLength(0);
    expect(api.ctx.store.getTrigger(trigger.id)!.lastError).toContain('No se pudo lanzar');
    expect(wrapper.emitted('close')).toBeUndefined(); // el diálogo sigue abierto para verlo
    expect(router.currentRoute.value.path).toBe('/');
  });
});

describe('TriggersModal: secreto de un webhook y eliminar', () => {
  it('regenerar el secreto pide confirmación: cancelar no cambia nada; confirmar enseña uno nuevo y el anterior deja de valer', async () => {
    const hook = addTrigger({ kind: 'webhook', intervalMinutes: null, name: 'Alertas' }, 'whsec_viejo');
    await open();

    await click('Nuevo secreto');
    await answerConfirm('Generar un secreto nuevo', null);
    expect(api.ctx.store.getTriggerSecret(hook.id)).toBe('whsec_viejo');
    expect(body().querySelector('[data-testid="webhook-secret"]')).toBeNull();

    await click('Nuevo secreto');
    await answerConfirm('Generar un secreto nuevo', 'Generar secreto');
    await until(() => Boolean(body().querySelector('[data-testid="webhook-secret"]')));
    const renewed = body().querySelector('[data-testid="webhook-secret"]')!.textContent!.trim();
    expect(renewed).toMatch(/^whsec_/);
    expect(renewed).not.toBe('whsec_viejo');
    expect(api.ctx.store.getTriggerSecret(hook.id)).toBe(renewed);

    const call = (token: string) => fetch(`/api/hooks/${hook.id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'x' });
    expect((await call('whsec_viejo')).status).toBe(401);
    const ok = await call(renewed);
    expect(ok.status).toBe(202);
    await api.ctx.runs.waitFor(((await ok.json()) as { runId: string }).runId);
  });

  it('eliminar pide confirmación: cancelar lo conserva; confirmar lo borra del servidor y vuelve la lista vacía', async () => {
    const keep = addTrigger({ intervalMinutes: 15, name: 'Se queda' });
    const drop = addTrigger({ intervalMinutes: 45, name: 'Se va' });
    await open();
    expect(items()).toHaveLength(2);

    await click('Eliminar el disparador Se va');
    await answerConfirm('Eliminar disparador', null);
    expect(triggers()).toHaveLength(2);

    await click('Eliminar el disparador Se va');
    await until(() => Boolean(body().querySelector('[role="dialog"][aria-label="Eliminar disparador"]')));
    expect(useUi().confirmState?.message).toBe('El workflow dejará de ejecutarse cada 45 min.');
    await answerConfirm('Eliminar disparador', 'Eliminar disparador');
    await until(() => triggers().length === 1);
    expect(api.ctx.store.getTrigger(drop.id)).toBeNull();
    expect(api.ctx.store.getTrigger(keep.id)).not.toBeNull();
    await until(() => toasts().includes('Disparador eliminado.'));
    await until(() => items().length === 1);

    await click('Eliminar el disparador Se queda');
    await answerConfirm('Eliminar disparador', 'Eliminar disparador');
    await until(() => triggers().length === 0);
    await until(() => text().includes('Este workflow todavía no tiene disparadores'));
  });

  it('eliminar un webhook avisa de que quien lo llame dejará de lanzar el workflow, y oculta su secreto recién creado', async () => {
    await open();
    await click('Añadir disparador');
    await click('Webhook');
    await click('Crear disparador');
    await until(() => Boolean(body().querySelector('[data-testid="webhook-secret"]')));
    const [hook] = triggers();

    await until(() => items().length === 1);
    await click('Eliminar el disparador al recibir un webhook');
    await until(() => Boolean(useUi().confirmState));
    expect(useUi().confirmState?.message).toBe('Los programas que llamen a esta dirección dejarán de lanzar el workflow.');
    await answerConfirm('Eliminar disparador', 'Eliminar disparador');
    await until(() => triggers().length === 0);
    expect(body().querySelector('[data-testid="webhook-secret"]')).toBeNull();
    // La dirección ya no existe.
    const res = await fetch(`/api/hooks/${hook.id}`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('TriggersModal: cierre', () => {
  it('«Hecho» cierra el diálogo', async () => {
    await open();
    await click('Hecho');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
