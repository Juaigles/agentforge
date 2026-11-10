import { expect, test, unique } from './support/fixtures';

test.describe('Persistencia tras reiniciar el servidor', () => {
  test('agentes, workflows y ejecuciones sobreviven a un corte brusco; lo que estaba a medias queda marcado', async ({ page, app }) => {
    const agentName = unique('Persistente');
    // El agente se crea desde la interfaz, como haría un usuario.
    await page.goto('/agents/new');
    await page.getByLabel('Nombre').fill(agentName);
    await page.getByLabel('Rol').fill('guardián de datos');
    await page.getByLabel('Instrucciones del sistema').fill('[[decir:respuesta que debe sobrevivir]]');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page).toHaveURL(/\/agents\/agt_/);
    const agentId = page.url().split('/').pop()!;

    const wf = await app.createWorkflow(
      unique('Flujo persistente'),
      [
        { id: 'entrada', type: 'input' },
        { id: 'paso', type: 'agent', label: 'Paso único', config: { agentId, prompt: '{{input}}' } },
        { id: 'salida', type: 'output', config: { template: '{{paso}}' } },
      ],
      ['entrada>paso', 'paso>salida'],
    );
    const done = await app.runToEnd('workflows', wf.id, 'antes del reinicio');
    expect(done.status).toBe('completed');

    // Una ejecución lenta queda a medias cuando se mata el proceso.
    const slowAgent = await app.createAgent({ name: unique('Lento'), systemPrompt: '[[lento]]' });
    const halfway = await app.api('POST', `/api/agents/${slowAgent.id}/run`, { input: 'no terminará' });
    await expect.poll(async () => (await app.api('GET', `/api/runs/${halfway.id}`)).status).toBe('running');

    await app.restart();

    // Tras el reinicio la interfaz muestra exactamente lo que había.
    await page.goto(`/agents/${agentId}`);
    await expect(page.getByLabel('Nombre')).toHaveValue(agentName);
    await expect(page.getByLabel('Rol')).toHaveValue('guardián de datos');
    await expect(page.getByLabel('Instrucciones del sistema')).toHaveValue('[[decir:respuesta que debe sobrevivir]]');

    await page.goto(`/workflows/${wf.id}`);
    await expect(page.getByLabel('Nombre del workflow')).toHaveValue(wf.name);
    await expect(page.locator('.vue-flow__node')).toHaveCount(3);
    await expect(page.locator('.vue-flow__edge')).toHaveCount(2);
    await expect(page.locator('.check-badge')).toHaveText(/Válido/);

    await page.goto(`/runs/${done.id}`);
    await expect(page.locator('.page-header .badge').first()).toHaveText('Completado');
    await expect(page.locator('.panel .output')).toContainText('respuesta que debe sobrevivir');
    await page.getByRole('tab', { name: /Actividad/ }).click();
    await expect(page.locator('.panel .activity li').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Entrada' }).click();
    await expect(page.locator('.panel .codeblock')).toHaveText('antes del reinicio');

    await page.goto(`/runs/${halfway.id}`);
    await expect(page.locator('.page-header .badge').first()).toHaveText('Fallido');
    await expect(page.getByRole('alert')).toContainText('Ejecución interrumpida por un reinicio del servidor.');

    // Y el servidor reiniciado sigue ejecutando con normalidad.
    const after = await app.runToEnd('workflows', wf.id, 'después del reinicio');
    expect(after.status).toBe('completed');
    expect(after.output).toContain('respuesta que debe sobrevivir');
  });

  test('una página abierta se recupera sola cuando el servidor vuelve', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Reconexión') });
    await page.goto('/runs');
    await page.getByLabel('Buscar ejecuciones').fill(agent.name);
    await expect(page.getByRole('heading', { name: 'Ninguna ejecución coincide con el filtro' })).toBeVisible();

    await app.restart();

    // Sin recargar: el canal de eventos se reconecta y la nueva ejecución aparece en la lista.
    await expect
      .poll(async () => page.evaluate(() => fetch('/api/health').then((r) => r.ok, () => false)), { timeout: 15_000 })
      .toBe(true);
    await expect(async () => {
      await app.runToEnd('agents', agent.id, 'tras reconectar');
      await expect(page.locator('tbody tr').filter({ hasText: agent.name }).first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30_000 });
  });
});
