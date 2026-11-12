import type { Page } from '@playwright/test';
import { expect, test, toast, unique, type AppHandle } from './support/fixtures';

const status = (page: Page) => page.locator('.page-header .badge').first();
const stepRow = (page: Page, label: string) => page.getByLabel('Pasos').locator('.step').filter({ hasText: label });

/** entrada → a → b → salida, con dos agentes cuyo comportamiento fija cada test en la plantilla. */
async function twoStepWorkflow(app: AppHandle, name: string, promptA: string, promptB: string) {
  const agent = await app.createAgent({ name: unique('Agente') });
  return app.createWorkflow(
    name,
    [
      { id: 'entrada', type: 'input' },
      { id: 'a', type: 'agent', label: 'Paso A', config: { agentId: agent.id, prompt: promptA } },
      { id: 'b', type: 'agent', label: 'Paso B', config: { agentId: agent.id, prompt: promptB } },
      { id: 'salida', type: 'output', config: { template: '{{b}}' } },
    ],
    ['entrada>a', 'a>b', 'b>salida'],
  );
}

test.describe('Ejecuciones', () => {
  test('cancelar una ejecución en curso desde el monitor', async ({ page, app }) => {
    const wf = await twoStepWorkflow(app, unique('Cancelable'), '[[lento]] {{input}}', 'después de {{a}}');
    await page.goto('/workflows');
    const card = page.locator('.card').filter({ hasText: wf.name });
    await card.getByRole('button', { name: 'Ejecutar' }).click();
    await page
      .getByRole('dialog', { name: `Ejecutar «${wf.name}»` })
      .getByRole('button', { name: 'Ejecutar' })
      .click();
    await expect(page).toHaveURL(/\/runs\/run_/);
    const runId = page.url().split('/').pop()!;

    await expect(status(page)).toHaveText('En curso');
    await expect(page.locator('.stream .output')).toContainText('palabra-2');
    // El contador de la barra lateral refleja la ejecución activa mediante el canal global de eventos.
    await expect(page.getByRole('navigation', { name: 'Principal' }).locator('.count')).toHaveText('1');

    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(status(page)).toHaveText('Cancelado');
    await expect(page.getByRole('alert')).toContainText('Ejecución cancelada por el usuario.');
    await expect(page.getByRole('navigation', { name: 'Principal' }).locator('.count')).toHaveCount(0);
    await expect(stepRow(page, 'Paso A').locator('.badge')).toHaveAttribute('title', 'Cancelado');
    await expect(stepRow(page, 'Paso B').locator('.badge')).toHaveAttribute('title', 'Cancelado');
    // Lo generado antes de cancelar sigue visible en el paso.
    await stepRow(page, 'Paso A').click();
    await expect(page.locator('.panel .output')).toContainText('palabra-2');

    const run = await app.api('GET', `/api/runs/${runId}`);
    expect(run.status).toBe('cancelled');
    // El modelo dejó de recibir trabajo: el paso B nunca llegó a pedirse.
    expect(app.fake.chats.some((c) => c.user.startsWith('después de'))).toBe(false);
    // Ya no se ofrece cancelar, sino repetir o reanudar.
    await expect(page.getByRole('button', { name: 'Cancelar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Repetir' })).toBeVisible();
  });

  test('cancelar desde la lista de ejecuciones', async ({ page, app }) => {
    const wf = await twoStepWorkflow(app, unique('Cancelable lista'), '[[lento]] {{input}}', '{{a}}');
    const run = await app.api('POST', `/api/workflows/${wf.id}/run`, { input: 'x' });
    await page.goto('/runs');
    const row = page.locator('tbody tr').filter({ hasText: wf.name });
    await expect(row.locator('.badge').first()).toHaveText('En curso');
    await row.getByRole('button', { name: `Cancelar ${wf.name}` }).click();
    // La fila se actualiza sola (sin recargar) al llegar el evento.
    await expect(row.locator('.badge').first()).toHaveText('Cancelado');
    expect((await app.waitForRun(run.id)).status).toBe('cancelled');
  });

  test('reintentar desde el fallo reutiliza los pasos completados; repetir lo rehace todo', async ({ page, app }) => {
    const wf = await twoStepWorkflow(app, unique('Reintentable'), '[[decir:alfa]] {{input}}', '[[fallo:paso-b]] usa {{a}}');
    app.fake.failing.add('paso-b');
    const failed = await app.runToEnd('workflows', wf.id, 'dato');
    expect(failed.status).toBe('failed');

    await page.goto(`/runs/${failed.id}`);
    await expect(status(page)).toHaveText('Fallido');
    await expect(page.getByRole('alert').first()).toContainText('fallo simulado (paso-b)');
    await expect(stepRow(page, 'Paso A').locator('.badge')).toHaveAttribute('title', 'Completado');
    await expect(stepRow(page, 'Paso B').locator('.badge')).toHaveAttribute('title', 'Fallido');
    await expect(page.locator('.graph .vue-flow__node[data-id="b"] .flow-node')).toHaveClass(/st-failed/);

    // Se arregla la causa y se reanuda desde el fallo.
    app.fake.failing.clear();
    const chatsBefore = app.fake.chats.length;
    await page.getByRole('button', { name: 'Reintentar desde el fallo' }).click();
    await expect(page).not.toHaveURL(new RegExp(failed.id));
    await expect(page).toHaveURL(/\/runs\/run_/);
    const retryId = page.url().split('/').pop()!;
    await expect(status(page)).toHaveText('Completado');
    await expect(page.getByRole('link', { name: 'reintento de una ejecución anterior' })).toHaveAttribute('href', `/runs/${failed.id}`);
    await expect(page.locator('.panel .output')).toContainText('Eco: usa alfa');

    // Solo se volvió a llamar al modelo para el paso que había fallado.
    const retryChats = app.fake.chats.slice(chatsBefore);
    expect(retryChats.map((c) => c.user)).toEqual(['[[fallo:paso-b]] usa alfa']);
    await page.getByRole('tab', { name: /Actividad/ }).click();
    await expect(page.locator('.panel .activity')).toContainText('Resultado reutilizado de la ejecución anterior');
    const retry = await app.api('GET', `/api/runs/${retryId}`);
    expect(retry.retryOf).toBe(failed.id);
    expect(retry.usage.llmCalls).toBe(1);

    // «Repetir» lanza una ejecución nueva completa (dos llamadas al modelo).
    const before = app.fake.chats.length;
    await page.getByRole('button', { name: 'Repetir' }).click();
    await expect(page).not.toHaveURL(new RegExp(retryId));
    await expect(status(page)).toHaveText('Completado');
    expect(app.fake.chats.length - before).toBe(2);
  });

  test('con la política «continuar», un fallo no detiene las ramas independientes', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Agente') });
    const wf = await app.createWorkflow(
      unique('Continuar'),
      [
        { id: 'entrada', type: 'input' },
        { id: 'falla', type: 'agent', label: 'Rama que falla', config: { agentId: agent.id, prompt: '[[fallo:rama]] {{input}}' } },
        { id: 'sigue', type: 'agent', label: 'Rama sana', config: { agentId: agent.id, prompt: '[[decir:rama sana terminada]] {{input}}' } },
        { id: 'salida', type: 'output', config: { template: '{{sigue}}' } },
      ],
      ['entrada>falla', 'entrada>sigue', 'sigue>salida'],
      { onError: 'continue' },
    );
    app.fake.failing.add('rama');
    const run = await app.runToEnd('workflows', wf.id, 'x');
    await page.goto(`/runs/${run.id}`);
    await expect(stepRow(page, 'Rama que falla').locator('.badge')).toHaveAttribute('title', 'Fallido');
    await expect(stepRow(page, 'Rama sana').locator('.badge')).toHaveAttribute('title', 'Completado');
    await expect(page.locator('.panel .output')).toContainText('rama sana terminada');
  });

  test('historial: filtros por estado y tipo, búsqueda, apertura y borrado', async ({ page, app }) => {
    const token = unique('hist').replace(/\s/g, '-');
    const ok = await twoStepWorkflow(app, `Bien ${token}`, '[[decir:uno]]', '[[decir:dos]]');
    const bad = await twoStepWorkflow(app, `Mal ${token}`, '[[fallo:hist]]', 'x');
    const slow = await twoStepWorkflow(app, `Lento ${token}`, '[[lento]]', 'x');
    const agent = await app.createAgent({ name: `Solo ${token}` });

    app.fake.failing.add('hist');
    await app.runToEnd('workflows', ok.id, 'entrada correcta');
    await app.runToEnd('workflows', bad.id, 'entrada que falla');
    const cancelled = await app.api('POST', `/api/workflows/${slow.id}/run`, { input: 'entrada lenta' });
    await app.api('POST', `/api/runs/${cancelled.id}/cancel`);
    await app.waitForRun(cancelled.id);
    await app.runToEnd('agents', agent.id, 'tarea del agente');

    await page.goto('/runs');
    const rows = page.locator('tbody tr');
    const search = page.getByLabel('Buscar ejecuciones');
    await search.fill(token);
    await expect(rows).toHaveCount(4);
    await expect(page.getByText('Mostrando 4 de 4')).toBeVisible();

    const filter = page.getByRole('group', { name: 'Filtrar por estado' });
    await filter.getByRole('button', { name: 'Completadas' }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: `Bien ${token}` })).toHaveCount(1);
    await expect(rows.filter({ hasText: `Solo ${token}` })).toHaveCount(1);

    await page.getByLabel('Filtrar por tipo').selectOption('agent');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`Solo ${token}`);
    await expect(rows.first()).toContainText('tarea del agente');

    await page.getByLabel('Filtrar por tipo').selectOption('workflow');
    await filter.getByRole('button', { name: 'Fallidas' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`Mal ${token}`);
    await expect(rows.first()).toContainText('fallo simulado (hist)');

    await filter.getByRole('button', { name: 'Canceladas' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`Lento ${token}`);

    // Sin coincidencias: estado vacío con la salida para quitar filtros.
    await filter.getByRole('button', { name: 'En curso' }).click();
    await expect(page.getByRole('heading', { name: 'Ninguna ejecución coincide con el filtro' })).toBeVisible();
    await page.getByRole('button', { name: 'Quitar filtros' }).click();
    await expect(search).toHaveValue('');

    // Búsqueda por el texto de entrada, y apertura del monitor con clic en la fila.
    await search.fill('entrada que falla');
    await expect(rows).toHaveCount(1);
    await rows.first().click();
    await expect(page).toHaveURL(/\/runs\/run_/);
    await expect(page.getByRole('heading', { level: 1, name: `Mal ${token}` })).toBeVisible();

    // Borrado desde la lista, con confirmación.
    await page.getByRole('link', { name: 'Volver a ejecuciones' }).click();
    await page.getByLabel('Buscar ejecuciones').fill(token);
    await expect(rows).toHaveCount(4);
    await page.getByRole('button', { name: `Eliminar ejecución de Bien ${token}` }).click();
    await page.getByRole('dialog', { name: 'Eliminar ejecución' }).getByRole('button', { name: 'Eliminar' }).click();
    await expect(rows).toHaveCount(3);
    const remaining = await app.api('GET', `/api/runs?search=${encodeURIComponent(token)}`);
    expect(remaining.total).toBe(3);
  });

  test('la lista se actualiza sola cuando empieza y termina una ejecución', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('En vivo') });
    await page.goto('/runs');
    await page.getByLabel('Buscar ejecuciones').fill(agent.name);
    await expect(page.getByRole('heading', { name: 'Ninguna ejecución coincide con el filtro' })).toBeVisible();

    const run = await app.api('POST', `/api/agents/${agent.id}/run`, { input: '[[ritmo:80]] [[palabras:25]]' });
    const row = page.locator('tbody tr').filter({ hasText: agent.name });
    await expect(row.locator('.badge').first()).toHaveText('En curso');
    await expect(row.locator('.badge').first()).toHaveText('Completado');
    // No se está mirando esa ejecución: llega un aviso con enlace a ella.
    const notice = toast(page, `«${agent.name}» ha terminado.`);
    await expect(notice).toBeVisible();
    await notice.getByRole('link', { name: 'Ver' }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${run.id}$`));
  });

  test('una ejecución inexistente muestra un error claro', async ({ page }) => {
    await page.goto('/runs/run_no_existe');
    await expect(page.getByRole('heading', { name: 'No se pudo cargar la ejecución' })).toBeVisible();
    await page.getByRole('link', { name: 'Volver a ejecuciones' }).click();
    await expect(page).toHaveURL(/\/runs$/);
  });
});
