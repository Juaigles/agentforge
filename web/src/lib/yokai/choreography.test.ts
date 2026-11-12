import type { Agent, NodeType, RunSnapshot, RunStatus, StepStatus, WorkflowNode } from '@shared/types';
import { describe, expect, it } from 'vitest';
import type { ActivityLog, RunLive, StepLive } from '../run-state';
import { actorsFromRun, COURIER_COLOR, courierTarget } from './choreography';
import { ROOMS, seatFor } from './map';
import { speciesFor } from './species';
import type { Actor } from './types';

const usage = { promptTokens: 0, completionTokens: 0, llmCalls: 0, toolCalls: 0 };
const emptyLog = (): ActivityLog => ({ items: [], firstSeq: 0, counts: {}, openTools: {}, orphanResults: {} });

const node = (id: string, type: NodeType, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const agentNode = (id: string, agentId: string): WorkflowNode => node(id, 'agent', { agentId, prompt: 'p' });

const agent = (id: string, color = `#${id.length}${id.length}0000`): Agent => ({ id, name: `Agente ${id}`, color }) as unknown as Agent;

function snapshot(nodes: WorkflowNode[], agents: Agent[] = []): RunSnapshot {
  return {
    workflow: { nodes, edges: [], settings: { maxConcurrency: 1, maxDurationMs: 1, maxLlmCalls: 1, onError: 'fail', defaultRetries: 0 } },
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
  };
}

interface StepInit {
  status?: StepStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  streamText?: string;
}

/** Estado en vivo con un paso por nodo (en el orden de los nodos); `init` ajusta los pasos que interesan. */
function live(snap: RunSnapshot, status: RunStatus, init: Record<string, StepInit> = {}, activity: ActivityLog = emptyLog()): RunLive {
  const steps: Record<string, StepLive> = {};
  for (const n of snap.workflow.nodes) {
    const i = init[n.id] ?? {};
    steps[n.id] = {
      runId: 'r1',
      nodeId: n.id,
      nodeType: n.type,
      label: n.label,
      agentId: (n.config.agentId as string) ?? null,
      status: i.status ?? 'pending',
      attempt: 1,
      input: null,
      output: null,
      error: null,
      usage: { ...usage },
      startedAt: i.startedAt ?? null,
      finishedAt: i.finishedAt ?? null,
      streamText: i.streamText ?? '',
      thinkingText: '',
    };
  }
  return {
    status,
    output: null,
    error: null,
    errorI18n: null,
    startedAt: null,
    finishedAt: null,
    steps,
    order: snap.workflow.nodes.map((n) => n.id),
    activity,
    lastSeq: 0,
    finalUsage: null,
  };
}

const ts = (s: number): string => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
const staff = (actors: Actor[]): Actor[] => actors.filter((a) => a.kind === 'staff');
const courierOf = (actors: Actor[]): Actor => actors.find((a) => a.kind === 'courier')!;

// Workflow típico: entrada → 2 agentes → herramienta → aprobación → salida.
const AGENTS = [agent('ana', '#ff0000'), agent('bo', '#00ff00')];
const WF = snapshot(
  [
    node('in', 'input'),
    agentNode('a1', 'ana'),
    agentNode('a2', 'bo'),
    node('t', 'tool', { tool: 'x' }),
    node('ok', 'approval'),
    node('fx', 'transform'),
    node('out', 'output'),
  ],
  AGENTS,
);

describe('actorsFromRun: plantilla', () => {
  it('crea un yōkai por nodo de agente, con el nombre, color y especie de su agente, y un mensajero al final', () => {
    const actors = actorsFromRun(WF, live(WF, 'queued'));
    expect(actors).toHaveLength(3);
    expect(actors.map((a) => a.key)).toEqual(['a1', 'a2', 'courier']);
    const [a1, a2] = staff(actors);
    expect(a1).toMatchObject({ kind: 'staff', name: 'Agente ana', color: '#ff0000', species: speciesFor('ana') });
    expect(a2).toMatchObject({ kind: 'staff', name: 'Agente bo', color: '#00ff00', species: speciesFor('bo') });
    expect(courierOf(actors)).toMatchObject({ kind: 'courier', key: 'courier', name: '', species: 'ojo', color: COURIER_COLOR });
  });

  it('pendiente: descansa en la cocina, sin actividad', () => {
    const [a1, a2] = staff(actorsFromRun(WF, live(WF, 'running')));
    expect(a1).toMatchObject({ room: 'cocina', seat: seatFor('cocina', 0), status: 'pending', activity: undefined });
    expect(a2).toMatchObject({ room: 'cocina', seat: seatFor('cocina', 1), status: 'pending', activity: undefined });
  });

  it('sin estado del paso cuenta como pendiente', () => {
    const l = live(WF, 'queued');
    delete l.steps.a1;
    expect(staff(actorsFromRun(WF, l))[0]).toMatchObject({ room: 'cocina', status: 'pending', activity: undefined });
  });

  it('en marcha: en su cubículo, pensando, escribiendo o con una herramienta', () => {
    const thinking = actorsFromRun(WF, live(WF, 'running', { a1: { status: 'running', startedAt: ts(1) } }));
    expect(staff(thinking)[0]).toMatchObject({ room: 'cubiculos', seat: seatFor('cubiculos', 0), status: 'running', activity: 'thinking' });

    const writing = actorsFromRun(WF, live(WF, 'running', { a2: { status: 'running', startedAt: ts(1), streamText: 'Hola' } }));
    expect(staff(writing)[1]).toMatchObject({ room: 'cubiculos', seat: seatFor('cubiculos', 1), activity: 'writing' });

    const log = emptyLog();
    log.openTools['a1|call1|0'] = { kind: 'tool' } as ActivityLog['openTools'][string];
    const tool = actorsFromRun(WF, live(WF, 'running', { a1: { status: 'running', startedAt: ts(1), streamText: 'x' } }, log));
    expect(staff(tool)[0].activity).toBe('tool');
  });

  it('esperando: en su cubículo con «waiting»', () => {
    const [a1] = staff(actorsFromRun(WF, live(WF, 'waiting', { a1: { status: 'waiting', startedAt: ts(1) } })));
    expect(a1).toMatchObject({ room: 'cubiculos', seat: seatFor('cubiculos', 0), status: 'waiting', activity: 'waiting' });
  });

  it('completado o fallido: se queda en su puesto mientras la ejecución sigue activa', () => {
    const l = live(WF, 'running', {
      a1: { status: 'completed', startedAt: ts(1), finishedAt: ts(2) },
      a2: { status: 'failed', startedAt: ts(1), finishedAt: ts(3) },
    });
    const [a1, a2] = staff(actorsFromRun(WF, l));
    expect(a1).toMatchObject({ room: 'cubiculos', seat: seatFor('cubiculos', 0), status: 'completed', activity: 'done' });
    expect(a2).toMatchObject({ room: 'cubiculos', seat: seatFor('cubiculos', 1), status: 'failed', activity: 'error' });
  });

  it.each(['completed', 'failed', 'cancelled'] as RunStatus[])('cuando la ejecución termina (%s), todos vuelven a la cocina', (runStatus) => {
    const l = live(WF, runStatus, {
      a1: { status: 'completed', startedAt: ts(1), finishedAt: ts(2) },
      a2: { status: runStatus === 'cancelled' ? 'cancelled' : 'failed', startedAt: ts(1), finishedAt: ts(3) },
    });
    const [a1, a2] = staff(actorsFromRun(WF, l));
    expect(a1).toMatchObject({ room: 'cocina', seat: seatFor('cocina', 0), status: 'completed', activity: 'done' });
    expect(a2.room).toBe('cocina');
    expect(a2.seat).toEqual(seatFor('cocina', 1));
  });

  it('omitido o cancelado: en la cocina, sin actividad, aunque la ejecución siga', () => {
    const l = live(WF, 'running', { a1: { status: 'skipped' }, a2: { status: 'cancelled' } });
    for (const a of staff(actorsFromRun(WF, l))) expect(a).toMatchObject({ room: 'cocina', activity: undefined });
  });

  it('un «para cada» con cuerpo de agente es plantilla; con cuerpo de herramienta o subworkflow, no', () => {
    const snap = snapshot(
      [
        node('fe', 'foreach', { body: 'agent', agentId: 'ana', items: '', prompt: '' }),
        node('fe2', 'foreach', { body: 'tool', tool: 'x' }),
        node('fe3', 'foreach', { body: 'subworkflow', workflowId: 'w2' }),
        node('sw', 'subworkflow', { workflowId: 'w2' }),
      ],
      AGENTS,
    );
    const actors = actorsFromRun(snap, live(snap, 'running', { fe: { status: 'running', startedAt: ts(1) } }));
    expect(staff(actors).map((a) => a.key)).toEqual(['fe']);
    expect(staff(actors)[0]).toMatchObject({ room: 'cubiculos', name: 'Agente ana', activity: 'thinking' });
    // El mensajero va a la sala de reuniones (la del tipo de paso), no al cubículo.
    expect(courierOf(actors).room).toBe('reunion');
  });

  it('agente que ya no está en la instantánea: sin nombre y con color neutro, pero con especie estable', () => {
    const snap = snapshot([agentNode('a', 'fantasma')]);
    const [a] = staff(actorsFromRun(snap, live(snap, 'queued')));
    expect(a.name).toBe('');
    expect(a.color).toMatch(/^#/);
    expect(a.species).toBe(speciesFor('fantasma'));
  });

  it('sin agentes: solo el mensajero', () => {
    const snap = snapshot([node('in', 'input'), node('t', 'tool'), node('out', 'output')]);
    const actors = actorsFromRun(snap, live(snap, 'running', { t: { status: 'running', startedAt: ts(1) } }));
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({ kind: 'courier', room: 'servidores', activity: 'tool', status: 'running' });
  });

  it('con 1 agente ocupa el primer cubículo', () => {
    const snap = snapshot([node('in', 'input'), agentNode('solo', 'ana')], AGENTS);
    const actors = actorsFromRun(snap, live(snap, 'running', { solo: { status: 'running', startedAt: ts(1) } }));
    expect(actors).toHaveLength(2);
    expect(staff(actors)[0]).toMatchObject({ key: 'solo', room: 'cubiculos', seat: ROOMS.cubiculos.seats[0] });
    expect(courierOf(actors)).toMatchObject({ room: 'cubiculos', activity: 'thinking' });
  });

  it('con 8 agentes los puestos dan la vuelta: el 7.º y el 8.º comparten cubículo con el 1.º y el 2.º', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const snap = snapshot(
      ids.map((id) => agentNode(`n${id}`, id)),
      ids.map((id) => agent(id)),
    );
    const running = Object.fromEntries(ids.map((id, i) => [`n${id}`, { status: 'running' as const, startedAt: ts(i) }]));
    const actors = staff(actorsFromRun(snap, live(snap, 'running', running)));
    expect(actors).toHaveLength(8);
    actors.forEach((a, i) => expect(a.seat).toEqual(ROOMS.cubiculos.seats[i % 6]));
    expect(actors[6].seat).toEqual(actors[0].seat);
    expect(actors[7].seat).toEqual(actors[1].seat);
    // En la cocina (7 sitios) el 8.º comparte con el 1.º.
    const resting = staff(actorsFromRun(snap, live(snap, 'queued')));
    resting.forEach((a, i) => expect(a.seat).toEqual(seatFor('cocina', i)));
    expect(resting[7].seat).toEqual(resting[0].seat);
  });

  it('las claves son estables y únicas', () => {
    const keys = actorsFromRun(WF, live(WF, 'running')).map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('courierTarget', () => {
  it('en cola o sin empezar: en la recepción', () => {
    expect(courierTarget(WF, live(WF, 'queued'))).toEqual({ room: 'recepcion', seat: ROOMS.recepcion.anchor });
    expect(courierTarget(WF, live(WF, 'running'))).toEqual({ room: 'recepcion', seat: ROOMS.recepcion.anchor });
  });

  it.each([
    ['in', 'recepcion', 'thinking'],
    ['a1', 'cubiculos', 'thinking'],
    ['t', 'servidores', 'tool'],
    ['fx', 'impresoras', 'thinking'],
    ['out', 'correo', 'thinking'],
  ] as const)('con el paso %s en marcha va a %s (%s)', (nodeId, room, activity) => {
    const target = courierTarget(WF, live(WF, 'running', { [nodeId]: { status: 'running', startedAt: ts(1) } }));
    expect(target).toEqual({ room, seat: ROOMS[room].anchor, activity });
  });

  it('una aprobación pendiente: en el despacho, esperando', () => {
    const target = courierTarget(WF, live(WF, 'waiting', { ok: { status: 'waiting', startedAt: ts(4) } }));
    expect(target).toEqual({ room: 'despacho', seat: ROOMS.despacho.anchor, activity: 'waiting' });
  });

  it('condición en el vestíbulo; subworkflow, delante del ascensor', () => {
    const snap = snapshot([node('c', 'condition'), node('sw', 'subworkflow', { workflowId: 'w2' })]);
    expect(courierTarget(snap, live(snap, 'running', { c: { status: 'running', startedAt: ts(1) } }))).toEqual({
      room: 'vestibulo',
      seat: ROOMS.vestibulo.anchor,
      activity: 'thinking',
    });
    expect(courierTarget(snap, live(snap, 'running', { sw: { status: 'running', startedAt: ts(1) } }))).toEqual({
      room: 'vestibulo',
      seat: ROOMS.vestibulo.seats[0],
      activity: 'thinking',
    });
  });

  it('con pasos en paralelo sigue al que empezó más tarde', () => {
    const l = live(WF, 'running', {
      a1: { status: 'running', startedAt: ts(5) },
      t: { status: 'running', startedAt: ts(7) },
      a2: { status: 'running', startedAt: ts(6) },
    });
    expect(courierTarget(WF, l).room).toBe('servidores');
    l.steps.a2.startedAt = ts(9);
    expect(courierTarget(WF, l).room).toBe('cubiculos');
  });

  it('entre dos pasos de una ejecución activa se queda donde terminó el último', () => {
    const l = live(WF, 'running', {
      in: { status: 'completed', startedAt: ts(1), finishedAt: ts(2) },
      t: { status: 'completed', startedAt: ts(3), finishedAt: ts(4) },
    });
    expect(courierTarget(WF, l)).toEqual({ room: 'servidores', seat: ROOMS.servidores.anchor });
  });

  it('terminada con éxito: en el correo, con «done»', () => {
    const l = live(WF, 'completed', { out: { status: 'completed', startedAt: ts(1), finishedAt: ts(2) } });
    expect(courierTarget(WF, l)).toEqual({ room: 'correo', seat: ROOMS.correo.anchor, activity: 'done' });
    expect(courierOf(actorsFromRun(WF, l)).status).toBe('completed');
  });

  it('fallida: en la sala del último paso que falló, con «error»', () => {
    const l = live(WF, 'failed', {
      t: { status: 'failed', startedAt: ts(1), finishedAt: ts(5) },
      fx: { status: 'failed', startedAt: ts(1), finishedAt: ts(3) },
    });
    expect(courierTarget(WF, l)).toEqual({ room: 'servidores', seat: ROOMS.servidores.anchor, activity: 'error' });
    expect(courierOf(actorsFromRun(WF, l)).status).toBe('failed');
  });

  it('fallida sin ningún paso fallido (p. ej. por tiempo): en la recepción, con «error»', () => {
    expect(courierTarget(WF, live(WF, 'failed'))).toEqual({ room: 'recepcion', seat: ROOMS.recepcion.anchor, activity: 'error' });
  });

  it('cancelada: de vuelta en la recepción, sin actividad', () => {
    const l = live(WF, 'cancelled', { a1: { status: 'cancelled', startedAt: ts(1), finishedAt: ts(2) } });
    expect(courierTarget(WF, l)).toEqual({ room: 'recepcion', seat: ROOMS.recepcion.anchor });
    expect(courierOf(actorsFromRun(WF, l)).status).toBe('cancelled');
  });

  it('usa el tipo guardado en el paso si el nodo ya no está en la instantánea', () => {
    const l = live(WF, 'running');
    l.steps.extra = { ...l.steps.t, nodeId: 'extra', nodeType: 'transform', status: 'running', startedAt: ts(1) };
    l.order.push('extra');
    expect(courierTarget(WF, l).room).toBe('impresoras');
  });

  it('el mensajero acompaña el estado del paso que sigue', () => {
    const courier = courierOf(actorsFromRun(WF, live(WF, 'waiting', { ok: { status: 'waiting', startedAt: ts(1) } })));
    expect(courier).toMatchObject({ room: 'despacho', status: 'waiting', activity: 'waiting' });
    expect(courierOf(actorsFromRun(WF, live(WF, 'queued'))).status).toBe('pending');
  });
});
