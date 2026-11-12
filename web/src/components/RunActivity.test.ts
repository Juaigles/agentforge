// @vitest-environment jsdom
import type { RunEvent, RunEventType } from '@shared/types';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick, reactive } from 'vue';
import { appendActivity, emptyActivity, prependActivity, type ActivityLog } from '@/lib/run-state';
import RunActivity from './RunActivity.vue';

let seq = 0;
const ev = (type: RunEventType, nodeId: string | null, data: Record<string, any> = {}): RunEvent => ({
  seq: ++seq,
  runId: 'r1',
  ts: `2026-01-01T10:00:${String(seq).padStart(2, '0')}.000Z`,
  type,
  nodeId,
  data,
});

/** Registro de actividad completo de una lista de eventos (desde el principio de la ejecución). */
function logOf(events: RunEvent[]): ActivityLog {
  const log = emptyActivity();
  log.firstSeq = 1;
  events.forEach((e) => appendActivity(log, e));
  return log;
}

function sampleEvents(): RunEvent[] {
  seq = 0;
  return [
    ev('run.started', null),
    ev('step.started', 'calc', { attempt: 1 }),
    ev('llm.message', 'calc', {
      agent: 'Calculista',
      content: '',
      thinking: 'Necesito la calculadora',
      toolCalls: [{ id: 't1', name: 'calculator', arguments: { expression: '2+2' } }],
      usage: { promptTokens: 12300, completionTokens: 40 },
    }),
    ev('tool.call', 'calc', { id: 't1', name: 'calculator', arguments: { expression: '2+2' } }),
    ev('tool.result', 'calc', { id: 't1', ok: true, result: '{"result":4}', durationMs: 3 }),
    ev('tool.call', 'calc', { id: 't2', name: 'web_fetch', arguments: { url: 'http://x.invalid' } }),
    ev('tool.result', 'calc', { id: 't2', ok: false, result: 'No se pudo conectar', durationMs: 12 }),
    ev('tool.call', 'calc', { id: 't3', name: 'file_read', arguments: { path: 'a.txt' } }),
    ev('llm.message', 'otro', { agent: 'Redactor', content: 'Texto final', usage: { promptTokens: 5, completionTokens: 5 } }),
    ev('step.finished', 'calc', { status: 'failed', error: 'Límite alcanzado' }),
    ev('run.finished', null, { status: 'failed', error: 'El nodo «calc» ha fallado' }),
  ];
}

describe('RunActivity', () => {
  it('muestra un texto vacío cuando no hay eventos', () => {
    const wrapper = mount(RunActivity, { props: { log: logOf([]) } });
    expect(wrapper.text()).toContain('Todavía no hay actividad.');
    expect(wrapper.find('ol').exists()).toBe(false);
  });

  it('lista marcadores, mensajes del modelo y llamadas a herramientas con su estado', () => {
    const wrapper = mount(RunActivity, { props: { log: logOf(sampleEvents()), labels: { calc: 'Resolver', otro: 'Redactar' } } });

    const markers = wrapper.findAll('li.marker').map((li) => li.text());
    expect(markers.some((t) => t.includes('Ejecución iniciada'))).toBe(true);
    expect(markers.some((t) => t.includes('Paso iniciado') && t.includes('Resolver'))).toBe(true);
    expect(markers.some((t) => t.includes('Ejecución fallida') && t.includes('El nodo «calc» ha fallado'))).toBe(true);
    expect(wrapper.find('li.marker.danger .detail').text()).toBe('Límite alcanzado');

    const messages = wrapper.findAll('li.message');
    expect(messages).toHaveLength(2);
    expect(messages[0].text()).toContain('Calculista');
    expect(messages[0].text()).toContain('pide 1 herramienta');
    expect(messages[0].text()).toContain('12.340 tokens');
    expect(messages[1].text()).toContain('Redactor');
    expect(messages[1].text()).toContain('responde');
    expect(messages[1].text()).toContain('Redactar'); // etiqueta del nodo en la vista de resumen

    const tools = wrapper.findAll('li.tool');
    expect(tools.map((t) => t.find('code').text())).toEqual(['calculator', 'web_fetch', 'file_read']);
    expect(tools[0].find('.badge').classes()).toContain('success');
    expect(tools[0].find('.badge').text()).toContain('OK');
    expect(tools[1].find('.badge').classes()).toContain('danger');
    expect(tools[1].find('.badge').text()).toContain('Error');
    // Una llamada sin resultado todavía se marca como en curso.
    expect(tools[2].find('.badge').text()).toBe('En curso');
  });

  it('despliega y pliega el detalle de mensajes y herramientas', async () => {
    const wrapper = mount(RunActivity, { props: { log: logOf(sampleEvents()) } });
    const message = wrapper.findAll('li.message')[0];
    const head = message.get('button.head');
    expect(head.attributes('aria-expanded')).toBe('false');
    expect(message.find('.content').exists()).toBe(false);

    await head.trigger('click');
    expect(head.attributes('aria-expanded')).toBe('true');
    expect(message.get('.content').text()).toContain('Necesito la calculadora');
    await head.trigger('click');
    expect(message.find('.content').exists()).toBe(false);

    const [okTool, failedTool, pendingTool] = wrapper.findAll('li.tool');
    await okTool.get('button.head').trigger('click');
    expect(okTool.get('.content').text()).toContain('"expression": "2+2"');
    expect(okTool.get('.content').text()).toContain('{"result":4}');
    await failedTool.get('button.head').trigger('click');
    expect(failedTool.get('.content .codeblock.bad').text()).toBe('No se pudo conectar');
    // En curso: se ven los argumentos pero aún no hay bloque de resultado.
    await pendingTool.get('button.head').trigger('click');
    expect(pendingTool.get('.content').text()).toContain('a.txt');
    expect(pendingTool.get('.content').text()).not.toContain('Resultado');
  });

  it('explica los mensajes sin texto ni razonamiento (solo piden herramientas)', async () => {
    seq = 0;
    const wrapper = mount(RunActivity, {
      props: { log: logOf([ev('llm.message', 'n', { agent: 'A', content: '', toolCalls: [{ id: 'x', name: 'calculator', arguments: {} }] })]) },
    });
    await wrapper.get('li.message button.head').trigger('click');
    expect(wrapper.get('li.message .content').text()).toBe('Sin texto: el modelo solo ha pedido herramientas.');
  });

  it('filtra por nodo y entonces no repite la etiqueta del nodo', () => {
    const wrapper = mount(RunActivity, { props: { log: logOf(sampleEvents()), nodeId: 'otro', labels: { otro: 'Redactar' } } });
    expect(wrapper.findAll('li')).toHaveLength(1);
    expect(wrapper.find('li.message').text()).toContain('Redactor');
    expect(wrapper.find('li.message').text()).not.toContain('Redactar');
    expect(wrapper.findAll('li.tool')).toHaveLength(0);
  });

  it('sangra la actividad de los agentes delegados según su profundidad', () => {
    seq = 0;
    const wrapper = mount(RunActivity, {
      props: {
        log: logOf([ev('llm.message', 'n', { agent: 'Jefe', content: 'delego' }), ev('llm.message', 'n', { agent: 'Ayudante', content: 'hecho', depth: 1 })]),
      },
    });
    const entries = wrapper.findAll('li.message .entry');
    expect(entries[0].attributes('style')).toContain('margin-left: 0px');
    expect(entries[1].attributes('style')).toContain('margin-left: 16px');
  });

  describe('ejecuciones largas', () => {
    /** `count` mensajes del modelo, alternando entre dos nodos, con `seq` a partir de `from`. */
    function messages(count: number, from = 1): RunEvent[] {
      seq = from - 1;
      return Array.from({ length: count }, (_v, i) => ev('llm.message', i % 2 ? 'par' : 'impar', { agent: `M${from + i}`, content: 'x' }));
    }
    const names = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('li.message strong').map((s) => s.text());
    const older = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('button').find((b) => b.text() === 'Cargar anteriores');

    it('pinta solo las 100 entradas más recientes y «Cargar anteriores» añade las 100 de antes', async () => {
      const wrapper = mount(RunActivity, { props: { log: logOf(messages(250)) } });
      expect(wrapper.findAll('li')).toHaveLength(100);
      expect(names(wrapper)[0]).toBe('M151');
      expect(names(wrapper).at(-1)).toBe('M250');
      expect(wrapper.get('[role="status"]').text()).toBe('Se muestran las 100 entradas más recientes.');

      await older(wrapper)!.trigger('click');
      expect(wrapper.findAll('li')).toHaveLength(200);
      expect(names(wrapper)[0]).toBe('M51');
      await older(wrapper)!.trigger('click');
      expect(wrapper.findAll('li')).toHaveLength(250);
      expect(names(wrapper)[0]).toBe('M1');
      // Ya está todo: el botón desaparece y no se pidió nada al servidor (estaba cargado).
      expect(older(wrapper)).toBeUndefined();
      expect(wrapper.emitted('older')).toBeUndefined();
    });

    it('una entrada nueva entra al final sin volver a crear las filas que ya estaban', async () => {
      const log = reactive(logOf(messages(120))) as ActivityLog;
      const wrapper = mount(RunActivity, { props: { log } });
      const kept = wrapper.findAll('li')[1].element;
      expect(names(wrapper)[1]).toBe('M22');

      seq = 120;
      appendActivity(log, ev('llm.message', 'par', { agent: 'M121', content: 'x' }));
      await nextTick();
      expect(wrapper.findAll('li')).toHaveLength(100);
      expect(names(wrapper).at(-1)).toBe('M121');
      // La ventana avanza una posición: la fila de M22 es el mismo elemento, ahora la primera.
      expect(wrapper.findAll('li')[0].element).toBe(kept);
    });

    it('con un nodo elegido la ventana es de ese nodo', async () => {
      const wrapper = mount(RunActivity, { props: { log: logOf(messages(250)), nodeId: 'par' } });
      expect(wrapper.findAll('li')).toHaveLength(100);
      expect(names(wrapper)[0]).toBe('M52');
      expect(names(wrapper).at(-1)).toBe('M250');
      await older(wrapper)!.trigger('click');
      expect(wrapper.findAll('li')).toHaveLength(125);
      expect(older(wrapper)).toBeUndefined();
      // Al cambiar de nodo se vuelve a la ventana inicial.
      await wrapper.setProps({ nodeId: 'impar' });
      expect(wrapper.findAll('li')).toHaveLength(100);
      expect(names(wrapper).at(-1)).toBe('M249');
    });

    it('si quedan eventos en el servidor pide la página anterior, la muestra al llegar y lleva el foco a la lista cuando ya no hay más', async () => {
      // Abierta por el final: están cargados los eventos 201-260 de 260.
      const log = reactive(emptyActivity()) as ActivityLog;
      prependActivity(log, messages(60, 201));
      const wrapper = mount(RunActivity, { props: { log, hasOlder: true }, attachTo: document.body });
      expect(wrapper.findAll('li')).toHaveLength(60);
      const button = older(wrapper)!;
      (button.element as HTMLButtonElement).focus();

      await button.trigger('click');
      expect(wrapper.emitted('older')).toHaveLength(1);
      await wrapper.setProps({ loadingOlder: true });
      expect(wrapper.get('.older button').attributes('disabled')).toBeDefined();
      expect(wrapper.get('.older button').text()).toBe('Cargando…');

      // Llega la página anterior (eventos 1-200): se ven 200 entradas y aún quedan 60 cargadas sin pintar.
      prependActivity(log, messages(200, 1));
      await wrapper.setProps({ loadingOlder: false, hasOlder: false });
      expect(wrapper.findAll('li')).toHaveLength(200);
      expect(names(wrapper)[0]).toBe('M61');
      await older(wrapper)!.trigger('click');
      await nextTick();
      expect(wrapper.findAll('li')).toHaveLength(260);
      expect(older(wrapper)).toBeUndefined();
      expect(wrapper.emitted('older')).toHaveLength(1);
      expect(document.activeElement).toBe(wrapper.get('ol').element);
      wrapper.unmount();
    });

    it('si el nodo elegido no tiene actividad entre lo cargado, lo dice y ofrece cargar lo anterior', async () => {
      const log = emptyActivity();
      prependActivity(log, messages(10, 500));
      const wrapper = mount(RunActivity, { props: { log, nodeId: 'otro', hasOlder: true } });
      expect(wrapper.find('ol').exists()).toBe(false);
      expect(wrapper.text()).toContain('No hay actividad entre los eventos cargados.');
      await older(wrapper)!.trigger('click');
      expect(wrapper.emitted('older')).toHaveLength(1);
    });
  });
});
