// @vitest-environment jsdom
import type { RunEvent, RunEventType } from '@shared/types';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
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
    const wrapper = mount(RunActivity, { props: { events: [] } });
    expect(wrapper.text()).toContain('Todavía no hay actividad.');
    expect(wrapper.find('ol').exists()).toBe(false);
  });

  it('lista marcadores, mensajes del modelo y llamadas a herramientas con su estado', () => {
    const wrapper = mount(RunActivity, { props: { events: sampleEvents(), labels: { calc: 'Resolver', otro: 'Redactar' } } });

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
    const wrapper = mount(RunActivity, { props: { events: sampleEvents() } });
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
      props: { events: [ev('llm.message', 'n', { agent: 'A', content: '', toolCalls: [{ id: 'x', name: 'calculator', arguments: {} }] })] },
    });
    await wrapper.get('li.message button.head').trigger('click');
    expect(wrapper.get('li.message .content').text()).toBe('Sin texto: el modelo solo ha pedido herramientas.');
  });

  it('filtra por nodo y entonces no repite la etiqueta del nodo', () => {
    const wrapper = mount(RunActivity, { props: { events: sampleEvents(), nodeId: 'otro', labels: { otro: 'Redactar' } } });
    expect(wrapper.findAll('li')).toHaveLength(1);
    expect(wrapper.find('li.message').text()).toContain('Redactor');
    expect(wrapper.find('li.message').text()).not.toContain('Redactar');
    expect(wrapper.findAll('li.tool')).toHaveLength(0);
  });

  it('sangra la actividad de los agentes delegados según su profundidad', () => {
    seq = 0;
    const wrapper = mount(RunActivity, {
      props: {
        events: [ev('llm.message', 'n', { agent: 'Jefe', content: 'delego' }), ev('llm.message', 'n', { agent: 'Ayudante', content: 'hecho', depth: 1 })],
      },
    });
    const entries = wrapper.findAll('li.message .entry');
    expect(entries[0].attributes('style')).toContain('margin-left: 0px');
    expect(entries[1].attributes('style')).toContain('margin-left: 16px');
  });
});
