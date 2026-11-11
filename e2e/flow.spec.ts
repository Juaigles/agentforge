import type { Page } from '@playwright/test';
import { expect, test, toast, unique } from './support/fixtures';

const flowNode = (page: Page, text: string) => page.locator('.vue-flow__node').filter({ hasText: text });

test.describe('Motor · aprobación humana, subworkflows y «para cada» ampliado', () => {
  test('aprobación: el nodo se añade en el lienzo, la ejecución espera, se decide desde el aviso y sigue por la rama elegida', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Redactor e2e') });
    await page.goto('/workflows/new');
    const name = unique('Con visto bueno');
    await page.getByLabel('Nombre del workflow').fill(name);
    const palette = page.getByLabel('Paleta de nodos');
    const inspector = page.getByLabel('Propiedades');

    // entrada → agente → aprobación → (sí) transformación / (no) transformación
    await flowNode(page, 'Entrada').click();
    await palette.getByRole('button', { name: agent.name }).click();
    await inspector.getByLabel('Tarea (plantilla)').fill('[[decir:Borrador del comunicado]] {{input}}');
    await palette.getByRole('button', { name: 'Aprobación' }).click();
    await expect(inspector.getByRole('heading', { name: 'Aprobación' })).toBeVisible();
    await inspector.getByLabel('Qué se pide aprobar (plantilla)').fill('¿Publicamos esto?\n\n{{upstream}}');
    const approval = flowNode(page, 'Revisión');
    await expect(approval).toContainText('¿Publicamos esto?');

    await palette.getByRole('button', { name: 'Transformación' }).click();
    await inspector.getByLabel('Plantilla').fill('PUBLICADO');
    await expect(page.locator('.vue-flow__edge.branch-true')).toHaveCount(1);
    await approval.click();
    await palette.getByRole('button', { name: 'Transformación' }).click();
    // El comentario de quien decide está disponible como referencia insertable.
    await inspector.getByLabel('Plantilla').fill('DEVUELTO: ');
    await inspector.getByRole('button', { name: '{{revision.comment}}' }).click();
    await expect(inspector.getByLabel('Plantilla')).toHaveValue('DEVUELTO: {{revision.comment}}');
    await expect(page.locator('.vue-flow__edge.branch-false')).toHaveCount(1);

    // La salida que venía con el workflow nuevo no se usa: se quita para que el resultado sean las dos ramas.
    await flowNode(page, 'Salida').click();
    await inspector.getByRole('button', { name: 'Eliminar nodo' }).click();
    await expect(page.locator('.check-badge')).toHaveText(/Válido|aviso/);

    await page.getByRole('button', { name: 'Ejecutar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ejecutar workflow' });
    await dialog.getByRole('textbox').fill('nota de prensa');
    await dialog.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(page).toHaveURL(/\/runs\/run_/);
    const runId = page.url().split('/').pop()!;

    // La ejecución se detiene «en espera» y aparece el aviso con el texto a aprobar.
    await expect(page.locator('.page-header .badge').first()).toHaveText('En espera');
    await expect(page.getByText('La ejecución está detenida en «Revisión»')).toBeVisible();
    const banner = page.getByRole('region', { name: /espera tu decisión/ });
    await expect(banner.getByRole('link', { name })).toHaveAttribute('href', `/runs/${runId}`);
    await expect(banner).toContainText('¿Publicamos esto?');
    await expect(banner).toContainText('Borrador del comunicado');
    expect((await app.api('GET', `/api/runs/${runId}`)).status).toBe('waiting');
    // El aviso acompaña al usuario en cualquier pantalla.
    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Agentes' }).click();
    await expect(banner).toBeVisible();

    // Rechazar con un comentario: sigue por la rama «no» y el comentario llega al nodo siguiente.
    await banner.getByLabel(/Comentario para/).fill('Falta la fecha');
    await banner.getByRole('button', { name: 'Rechazar' }).click();
    await expect(toast(page, /Rechazado: .+ sigue por la otra rama\./)).toBeVisible();
    await expect(banner).toHaveCount(0);
    const done = await app.waitForRun(runId);
    expect(done.status).toBe('completed');
    expect(done.output).toBe('DEVUELTO: Falta la fecha');

    await page.goto(`/runs/${runId}`);
    await expect(page.locator('.page-header .badge').first()).toHaveText('Completado');
    await page.getByRole('tab', { name: /Actividad/ }).click();
    await expect(page.getByText('A la espera de una aprobación')).toBeVisible();
    await expect(page.locator('.activity').getByText(/^\s*Rechazado/)).toBeVisible();

    // Repetirla y aprobar: ahora sigue por la rama «sí».
    await page.getByRole('button', { name: 'Repetir' }).click();
    await expect(page.locator('.page-header .badge').first()).toHaveText('En espera');
    await page.getByRole('region', { name: /espera tu decisión/ }).getByRole('button', { name: 'Aprobar' }).click();
    await expect(page.locator('.page-header .badge').first()).toHaveText('Completado');
    await expect(page.locator('.panel .output')).toContainText('PUBLICADO');
  });

  test('una ejecución en espera de aprobación sobrevive a un reinicio del servidor y vuelve sola a pedir la decisión', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Previo') });
    const wf = await app.createWorkflow(
      unique('Espera larga'),
      [
        { id: 'entrada', type: 'input' },
        { id: 'previo', type: 'agent', config: { agentId: agent.id, prompt: '[[decir:hecho antes del reinicio]] {{input}}' } },
        { id: 'visto', type: 'approval', label: 'Visto bueno', config: { message: '¿Seguimos con {{previo}}?' } },
        { id: 'fin', type: 'transform', config: { template: 'TERMINADO' } },
      ],
      ['entrada>previo', 'previo>visto', 'visto:true>fin'],
    );
    const run = await app.api('POST', `/api/workflows/${wf.id}/run`, { input: 'x' });
    await expect.poll(async () => (await app.api('GET', `/api/runs/${run.id}`)).status).toBe('waiting');
    const before = app.fake.chats.length;

    // Apagado ordenado y arranque: la ejecución se reanuda sola (sin el aviso de «interrumpidas») y vuelve a esperar.
    expect(await app.shutdown()).toBe(0);
    await app.start();
    await page.goto('/');
    await expect(page.locator('.interrupted')).toHaveCount(0);
    const banner = page.getByRole('region', { name: /espera tu decisión/ });
    await expect(banner).toContainText('¿Seguimos con hecho antes del reinicio?');
    const pending = await app.api('GET', '/api/approvals');
    expect(pending).toHaveLength(1);
    expect(pending[0].runId).not.toBe(run.id);
    // El paso anterior no se ha repetido: se reutilizó su resultado.
    expect(app.fake.chats.length).toBe(before);

    await banner.getByRole('button', { name: 'Aprobar' }).click();
    const resumed = await app.waitForRun(pending[0].runId);
    expect(resumed).toMatchObject({ status: 'completed', output: 'TERMINADO', retryOf: run.id });
  });

  test('subworkflow: se elige en el inspector, su ejecución queda enlazada y un ciclo entre workflows se señala', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Trabajador') });
    const child = await app.createWorkflow(
      unique('Hijo resumidor'),
      [
        { id: 'entrada', type: 'input' },
        { id: 'resumen', type: 'agent', config: { agentId: agent.id, prompt: '[[decir:RESUMEN HECHO]] {{input}}' } },
        { id: 'salida', type: 'output', config: { template: 'R[{{resumen}}]' } },
      ],
      ['entrada>resumen', 'resumen>salida'],
    );
    await page.goto('/workflows/new');
    const parentName = unique('Padre con subflujo');
    await page.getByLabel('Nombre del workflow').fill(parentName);
    const palette = page.getByLabel('Paleta de nodos');
    const inspector = page.getByLabel('Propiedades');

    await flowNode(page, 'Entrada').click();
    await palette.getByRole('button', { name: 'Subworkflow' }).click();
    await expect(page.locator('.check-badge')).toHaveText(/error/);
    await inspector.locator('#in-subwf').selectOption({ label: child.name });
    await expect(flowNode(page, 'Subworkflow')).toContainText(child.name);
    // Se une a la salida que ya existía.
    const sub = flowNode(page, child.name);
    const out = flowNode(page, 'Salida');
    await sub.locator('.vue-flow__handle.source').dragTo(out.locator('.vue-flow__handle.target'));
    await expect(page.locator('.check-badge')).toHaveText(/Válido/);

    await page.getByRole('button', { name: 'Ejecutar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ejecutar workflow' });
    await dialog.getByRole('textbox').fill('texto largo');
    await dialog.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(page.locator('.page-header .badge').first()).toHaveText('Completado');
    await expect(page.locator('.panel .output')).toContainText('R[RESUMEN HECHO]');
    const runId = page.url().split('/').pop()!;

    // Desde el paso se llega a la subejecución, y desde ella se vuelve.
    await page.getByRole('button', { name: /Subworkflow/ }).first().click();
    const childLink = page.locator('.children').getByRole('link', { name: child.name });
    await expect(childLink).toBeVisible();
    await childLink.click();
    await expect(page.getByRole('heading', { name: child.name, level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'subejecución lanzada por otro workflow' })).toHaveAttribute('href', `/runs/${runId}`);
    await page.goto('/runs');
    await expect(page.locator('tr', { hasText: child.name }).first().getByText('subejecución')).toBeVisible();

    // El hijo no puede llamar al padre: sería un ciclo entre workflows.
    const parent = (await app.api('GET', '/api/workflows')).find((w: any) => w.name === parentName);
    await page.goto(`/workflows/${child.id}`);
    await flowNode(page, 'resumen').first().click();
    await palette.getByRole('button', { name: 'Subworkflow' }).click();
    await inspector.locator('#in-subwf').selectOption({ label: parentName });
    await expect(inspector.getByText(/acaba llamando a este mismo workflow \(ciclo entre workflows\)/)).toBeVisible();
    await expect(page.locator('.check-badge')).toHaveText(/error/);
    // Y el servidor no deja borrar un workflow que otro usa.
    const res = await fetch(`${app.url}/api/workflows/${child.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(parent).toBeTruthy();
  });

  test('«para cada» con una herramienta y política «continuar»: procesa los que puede y señala el que falla', async ({ page, app }) => {
    await page.goto('/workflows/new');
    await page.getByLabel('Nombre del workflow').fill(unique('Cálculos en serie'));
    const palette = page.getByLabel('Paleta de nodos');
    const inspector = page.getByLabel('Propiedades');
    await flowNode(page, 'Entrada').click();
    await palette.getByRole('button', { name: 'Para cada' }).click();
    await inspector.getByRole('radio', { name: 'Una herramienta' }).check();
    await inspector.locator('#in-tool').selectOption('calculator');
    await inspector.locator('#arg-expression').fill('{{item}}');
    await inspector.getByLabel('Si un elemento falla').selectOption('continue');
    await expect(flowNode(page, 'Para cada')).toContainText('Cada elemento → calculator');
    const each = flowNode(page, 'Para cada');
    await each.locator('.vue-flow__handle.source').dragTo(flowNode(page, 'Salida').locator('.vue-flow__handle.target'));
    await expect(page.locator('.check-badge')).toHaveText(/Válido/);

    await page.getByRole('button', { name: 'Ejecutar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ejecutar workflow' });
    await dialog.getByRole('textbox').fill('2+2\nesto no es una cuenta\n10/4');
    await dialog.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(page.locator('.page-header .badge').first()).toHaveText('Completado');
    const output = page.locator('.panel .output');
    await expect(output).toContainText('"result": 4');
    await expect(output).toContainText('"result": 2.5');
    await expect(output).toContainText('No se pudo completar');
    await expect(output).toContainText('1 de 3 elementos no se pudieron completar.');
    // Sin modelo: el proveedor no recibió ninguna petición de esta ejecución.
    const run = await app.api('GET', `/api/runs/${page.url().split('/').pop()}`);
    expect(run.usage).toMatchObject({ llmCalls: 0, toolCalls: 3 });
  });
});
