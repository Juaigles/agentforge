// Prueba de humo contra un servidor en marcha y un modelo real.
// Uso: node scripts/smoke.mjs agent "tarea"   |   node scripts/smoke.mjs workflow "<nombre parcial>" "input"
const BASE = process.env.AGENTFORGE_URL ?? 'http://127.0.0.1:4310';

async function api(path, init) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...init });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function follow(run) {
  const started = Date.now();
  let after = 0;
  for (;;) {
    const events = await api(`/api/runs/${run.id}/events?after=${after}`);
    for (const ev of events) {
      after = ev.seq;
      const d = ev.data;
      const tag = `[${String(ev.seq).padStart(3)}] ${ev.type.padEnd(14)} ${ev.nodeId ?? ''}`;
      if (ev.type === 'llm.message')
        console.log(tag, `tools=${d.toolCalls.map((t) => t.name).join(',') || '-'} tokens=${d.usage.promptTokens}/${d.usage.completionTokens}`);
      else if (ev.type === 'tool.call') console.log(tag, d.name, JSON.stringify(d.arguments).slice(0, 120));
      else if (ev.type === 'tool.result') console.log(tag, d.ok ? 'ok' : 'ERROR', String(d.result).replace(/\s+/g, ' ').slice(0, 120));
      else if (ev.type === 'step.finished') console.log(tag, d.status, d.error ?? '', `${d.durationMs ?? 0}ms`);
      else if (ev.type === 'step.retry' || ev.type === 'step.skipped') console.log(tag, d.error ?? d.reason);
      else console.log(tag);
    }
    const current = await api(`/api/runs/${run.id}`);
    if (!['queued', 'running'].includes(current.status)) {
      console.log(`\n=== ${current.status.toUpperCase()} en ${((Date.now() - started) / 1000).toFixed(1)}s · uso ${JSON.stringify(current.usage)}`);
      if (current.error) console.log('error:', current.error);
      console.log('--- salida ---\n' + (current.output ?? '(sin salida)'));
      return current;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'agent') {
  const agents = await api('/api/agents');
  const agent = agents.find((x) => x.name === (b ?? 'Analista')) ?? agents[0];
  console.log(`Agente: ${agent.name} (${agent.model})`);
  const run = await follow(await api(`/api/agents/${agent.id}/run`, { method: 'POST', body: JSON.stringify({ input: a }) }));
  process.exit(run.status === 'completed' ? 0 : 1);
} else if (mode === 'workflow') {
  const workflows = await api('/api/workflows');
  const wf = workflows.find((w) => w.name.toLowerCase().includes((a ?? '').toLowerCase())) ?? workflows[0];
  console.log(`Workflow: ${wf.name}`);
  const run = await follow(await api(`/api/workflows/${wf.id}/run`, { method: 'POST', body: JSON.stringify({ input: b ?? '' }) }));
  process.exit(run.status === 'completed' ? 0 : 1);
} else {
  console.log('Uso: smoke.mjs agent "<tarea>" [nombreAgente] | smoke.mjs workflow "<nombre>" "<input>"');
}
