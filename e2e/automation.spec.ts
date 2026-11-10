import fs from 'node:fs';
import { expect, test, toast, unique, type AppHandle } from './support/fixtures';

async function sampleWorkflow(app: AppHandle, name: string) {
  const agent = await app.createAgent({ name: unique('Portable'), systemPrompt: 'Responde breve.', tools: ['calculator'], role: 'viajero' });
  const wf = await app.createWorkflow(
    name,
    [
      { id: 'entrada', type: 'input', config: { defaultValue: 'dato por defecto' } },
      { id: 'paso', type: 'agent', label: 'Paso', config: { agentId: agent.id, prompt: '[[decir:uno\ndos]] {{input}}' } },
      { id: 'cada', type: 'foreach', label: 'Repetir', config: { agentId: agent.id, items: '{{paso}}', prompt: 'procesa {{item}}' } },
      { id: 'salida', type: 'output', config: { template: '{{cada}}' } },
    ],
    ['entrada>paso', 'paso>cada', 'cada>salida'],
  );
  return { agent, wf };
}

test.describe('Exportar e importar workflows', () => {
  test('exportar a un archivo, importarlo en limpio (recreando sus agentes) y volver a importarlo', async ({ page, app }) => {
    const name = unique('Exportable');
    const { agent, wf } = await sampleWorkflow(app, name);
    await page.goto('/workflows');

    // Exportación desde la lista: se descarga un JSON con la definición y el agente que usa.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Exportar ${name}` }).click()]);
    expect(download.suggestedFilename()).toMatch(/^exportable-.*\.agentforge\.json$/);
    const file = await download.path();
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(bundle).toMatchObject({ format: 'agentforge.workflow', version: 1, workflow: { name } });
    expect(bundle.workflow.nodes.map((n: any) => n.id)).toEqual(['entrada', 'paso', 'cada', 'salida']);
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.agents[0]).toMatchObject({ id: agent.id, name: agent.name, role: 'viajero', systemPrompt: 'Responde breve.', tools: ['calculator'] });
    expect(JSON.stringify(bundle)).not.toContain('providerId');
    await expect(toast(page, `«${name}» exportado.`)).toBeVisible();

    // Se borra todo y se importa el archivo descargado: el workflow y su agente vuelven a existir.
    await app.api('DELETE', `/api/workflows/${wf.id}`);
    await app.api('DELETE', `/api/agents/${agent.id}`);
    await page.reload();
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);

    await page.getByLabel('Archivo de workflow a importar').setInputFiles(file);
    await expect(toast(page, `«${name}» importado con 1 agente nuevo.`)).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\/wf_/);
    const importedId = page.url().split('/').pop()!;
    expect(importedId).not.toBe(wf.id);
    await expect(page.getByLabel('Nombre del workflow')).toHaveValue(name);
    await expect(page.locator('.vue-flow__node')).toHaveCount(4);
    await expect(page.locator('.vue-flow__edge')).toHaveCount(3);
    await expect(page.locator('.check-badge')).toHaveText(/Válido/);
    const recreated = (await app.api<any[]>('GET', '/api/agents')).find((a) => a.name === agent.name);
    expect(recreated).toMatchObject({ role: 'viajero', systemPrompt: 'Responde breve.', tools: ['calculator'] });
    expect(recreated.id).not.toBe(agent.id);
    // Y funciona: se ejecuta de principio a fin con el agente recreado.
    const run = await app.runToEnd('workflows', importedId, 'x');
    expect(run.status).toBe('completed');
    expect(run.output).toContain('### 2. dos');

    // Importarlo otra vez no duplica el agente ni pisa el nombre.
    await page.goto('/workflows');
    await page.getByLabel('Archivo de workflow a importar').setInputFiles(file);
    await expect(toast(page, `«${name} (importado)» importado.`)).toBeVisible();
    expect((await app.api<any[]>('GET', '/api/agents')).filter((a) => a.name === agent.name)).toHaveLength(1);

    // Exportación desde el constructor: guarda antes los cambios pendientes.
    await page.getByLabel('Nombre del workflow').fill(`${name} retocado`);
    const [second] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar' }).click()]);
    expect(JSON.parse(fs.readFileSync(await second.path(), 'utf8')).workflow.name).toBe(`${name} retocado`);
    await expect(page.getByText('Sin guardar')).toHaveCount(0);
  });

  test('rechaza archivos que no son un workflow exportado, sin crear nada', async ({ page, app }) => {
    await page.goto('/workflows');
    const before = (await app.api<any[]>('GET', '/api/workflows')).length;
    const input = page.getByLabel('Archivo de workflow a importar');

    await input.setInputFiles({ name: 'roto.json', mimeType: 'application/json', buffer: Buffer.from('{ esto no es json') });
    await expect(toast(page, '«roto.json» no es un archivo JSON válido.')).toBeVisible();

    await input.setInputFiles({ name: 'otro.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ nombre: 'cualquier cosa' })) });
    await expect(toast(page, 'no es un workflow exportado de AgentForge')).toBeVisible();

    await expect(page).toHaveURL(/\/workflows$/);
    expect((await app.api<any[]>('GET', '/api/workflows')).length).toBe(before);
  });

  test('al importar un workflow cuyas herramientas no existen aquí se avisa y queda señalado', async ({ page }) => {
    const name = unique('De fuera');
    const bundle = {
      format: 'agentforge.workflow',
      version: 1,
      exportedAt: new Date().toISOString(),
      workflow: {
        name,
        description: 'Venía de otra instalación',
        nodes: [
          { id: 'entrada', type: 'input', label: 'Entrada', position: { x: 0, y: 100 }, config: {} },
          { id: 'buscar', type: 'tool', label: 'Buscar', position: { x: 260, y: 100 }, config: { tool: 'buscador_interno', args: { q: '{{input}}' } } },
          { id: 'resumir', type: 'agent', label: 'Resumir', position: { x: 520, y: 100 }, config: { agentId: 'agt_ajeno', prompt: '{{buscar}}' } },
        ],
        edges: [
          { id: 'e1', source: 'entrada', target: 'buscar' },
          { id: 'e2', source: 'buscar', target: 'resumir' },
        ],
        settings: { maxConcurrency: 2, maxDurationMs: 60000, maxLlmCalls: 10, onError: 'fail', defaultRetries: 0 },
      },
      agents: [{ id: 'agt_ajeno', name: unique('Ajeno'), tools: ['buscador_interno', 'calculator'] }],
    };
    await page.goto('/workflows');
    await page.getByLabel('Archivo de workflow a importar').setInputFiles({ name: 'ajeno.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
    await expect(toast(page, `«${name}» importado con 1 agente nuevo.`)).toBeVisible();
    await expect(toast(page, 'usaba herramientas que no existen aquí: buscador_interno.')).toBeVisible();
    // El agente se enlazó; el nodo de herramienta desconocida queda como error de validación.
    await expect(page.locator('.check-badge')).toContainText('1 error');
    await page.locator('.check-badge').click();
    await expect(page.getByLabel('Propiedades').locator('.validation')).toContainText('herramienta desconocida: buscador_interno');
  });
});

test.describe('Ejecución programada', () => {
  test('programar un workflow desde el constructor, ejecutarlo ahora, cambiarlo, pausarlo y quitarlo', async ({ page, app }) => {
    const name = unique('Programable');
    const { wf } = await sampleWorkflow(app, name);
    await page.goto(`/workflows/${wf.id}`);
    await page.getByRole('button', { name: 'Programar' }).click();
    const modal = page.getByRole('dialog', { name: `Programar «${name}»` });
    // La entrada propuesta es el valor de ejemplo del workflow.
    await expect(modal.getByLabel('Entrada de cada ejecución')).toHaveValue('dato por defecto');

    await modal.getByLabel('Repetir cada').fill('0');
    await expect(modal.getByRole('alert')).toContainText('al menos 1 minuto');
    await expect(modal.getByRole('button', { name: 'Guardar programación' })).toBeDisabled();
    await modal.getByLabel('Repetir cada').fill('2');
    await modal.getByLabel('Unidad del intervalo').selectOption('hours');
    await expect(modal.getByText('Al guardar, se ejecutará cada 2 h.')).toBeVisible();
    await modal.getByLabel('Entrada de cada ejecución').fill('informe de la mañana');
    const savedAt = Date.now();
    await modal.getByRole('button', { name: 'Guardar programación' }).click();
    await expect(toast(page, `«${name}» se ejecutará cada 2 h.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Programar' })).toContainText('cada 2 h');

    const saved = await app.api('GET', `/api/workflows/${wf.id}/schedule`);
    expect(saved).toMatchObject({ kind: 'interval', intervalMinutes: 120, input: 'informe de la mañana', enabled: true, lastRunId: null });
    expect(Math.abs(Date.parse(saved.nextRunAt) - (savedAt + 120 * 60_000))).toBeLessThan(15_000);

    // «Ejecutar ahora» lanza una ejecución marcada como programada, con la entrada guardada.
    await page.getByRole('button', { name: 'Programar' }).click();
    await expect(modal.getByText('Todavía ninguna')).toBeVisible();
    await expect(modal.getByLabel('Repetir cada')).toHaveValue('2');
    await expect(modal.getByLabel('Unidad del intervalo')).toHaveValue('hours');
    await modal.getByRole('button', { name: 'Ejecutar ahora' }).click();
    await expect(page).toHaveURL(/\/runs\/run_/);
    const runId = page.url().split('/').pop()!;
    await expect(page.locator('.page-header .badge').first()).toHaveText('Completado');
    await expect(page.locator('.page-header .subtitle')).toContainText('ejecución programada');
    await page.getByRole('tab', { name: 'Entrada' }).click();
    await expect(page.locator('.panel .codeblock')).toHaveText('informe de la mañana');
    expect((await app.api('GET', `/api/workflows/${wf.id}/schedule`)).nextRunAt).toBe(saved.nextRunAt); // la cita no se mueve

    await page.getByRole('link', { name: 'Volver a ejecuciones' }).click();
    await page.getByLabel('Buscar ejecuciones').fill(name);
    await expect(page.locator('tbody tr').first().getByText('programada')).toBeVisible();

    // Desde la lista de workflows: se ve la cadencia, se cambia a diaria, se pausa y se quita.
    await page.goto('/workflows');
    const card = page.locator('article.wf').filter({ hasText: name });
    await expect(card.getByText('cada 2 h')).toBeVisible();
    await card.getByRole('button', { name: `Programar ${name}` }).click();
    await expect(modal.locator('.state').getByRole('link')).toHaveAttribute('href', `/runs/${runId}`); // última ejecución
    await modal.getByRole('radio', { name: 'Cada día a una hora' }).click();
    await modal.getByLabel('Hora').fill('07:45');
    await modal.getByRole('button', { name: 'Guardar programación' }).click();
    await expect(card.getByText('cada día a las 07:45')).toBeVisible();
    expect(await app.api('GET', `/api/workflows/${wf.id}/schedule`)).toMatchObject({ kind: 'daily', time: '07:45', intervalMinutes: null });

    await card.getByRole('button', { name: `Programar ${name}` }).click();
    await modal.getByRole('checkbox').uncheck();
    await modal.getByRole('button', { name: 'Guardar programación' }).click();
    await expect(toast(page, 'Programación guardada, pero desactivada.')).toBeVisible();
    await expect(card.getByText('programación en pausa')).toBeVisible();
    expect(await app.api('GET', `/api/workflows/${wf.id}/schedule`)).toMatchObject({ enabled: false, nextRunAt: null });

    await card.getByRole('button', { name: `Programar ${name}` }).click();
    await expect(modal.getByText('Pausada')).toBeVisible();
    await modal.getByRole('button', { name: 'Quitar programación' }).click();
    await expect(toast(page, 'Programación eliminada.')).toBeVisible();
    await expect(card.getByText('programación en pausa')).toHaveCount(0);
    expect(await app.api('GET', `/api/workflows/${wf.id}/schedule`)).toBeNull();
  });

  test('el temporizador del servidor lanza la ejecución a su hora, sin intervención', async ({ page, app }) => {
    test.setTimeout(120_000);
    const name = unique('Cada minuto');
    const { wf } = await sampleWorkflow(app, name);
    await page.goto('/runs');
    await page.getByLabel('Buscar ejecuciones').fill(name);
    await expect(page.getByRole('heading', { name: 'Ninguna ejecución coincide con el filtro' })).toBeVisible();

    const scheduled = await app.api('PUT', `/api/workflows/${wf.id}/schedule`, { kind: 'interval', intervalMinutes: 1, input: 'automático' });
    const due = Date.parse(scheduled.nextRunAt);
    // Sin tocar nada más: al cumplirse el minuto la ejecución aparece sola en la lista, marcada como programada.
    const row = page.locator('tbody tr').filter({ hasText: name });
    await expect(row).toHaveCount(1, { timeout: 90_000 });
    await expect(row.getByText('programada')).toBeVisible();
    await expect(row.locator('td').nth(1).locator('.badge')).toHaveText('Completado');
    await expect(row).toContainText('automático');

    const runs = (await app.api('GET', `/api/runs?search=${encodeURIComponent(name)}`)).items;
    expect(runs).toHaveLength(1);
    expect(runs[0].scheduled).toBe(true);
    // No se adelantó: arrancó después de su hora (y dentro del margen del temporizador).
    expect(Date.parse(runs[0].createdAt)).toBeGreaterThanOrEqual(due);
    expect(Date.parse(runs[0].createdAt) - due).toBeLessThan(10_000);
    const after = await app.api('GET', `/api/workflows/${wf.id}/schedule`);
    expect(after.lastRunId).toBe(runs[0].id);
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(due);
    await app.api('DELETE', `/api/workflows/${wf.id}/schedule`);
  });
});
