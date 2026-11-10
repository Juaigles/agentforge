import type { Locator, Page } from '@playwright/test';
import { expect, test, toast, unique } from './support/fixtures';

const node = (page: Page, id: string) => page.locator(`.vue-flow__node[data-id="${id}"]`);

/** Posición de un elemento cuando deja de moverse (el lienzo anima sus reencuadres). */
async function stableBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let previous = '';
  for (let i = 0; i < 40; i++) {
    const box = await locator.boundingBox();
    const key = JSON.stringify(box);
    if (box && key === previous) return box;
    previous = key;
    await locator.page().waitForTimeout(60);
  }
  throw new Error('El punto de conexión no se estabilizó.');
}

/** Une dos nodos arrastrando con el ratón desde el punto de salida de uno al de entrada del otro. */
async function connect(page: Page, from: Locator, to: Locator, sourceHandle = '.vue-flow__handle.source'): Promise<void> {
  const a = await stableBox(from.locator(sourceHandle).first());
  const b = await stableBox(to.locator('.vue-flow__handle.target'));
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test.describe('Constructor de workflows', () => {
  test('construir un workflow desde cero en el lienzo, validarlo, ejecutarlo y seguirlo en el monitor en vivo', async ({ page, app }) => {
    const analista = await app.createAgent({ name: unique('Analista'), systemPrompt: '[[ritmo:60]] [[palabras:30]]' });
    const redactor = await app.createAgent({ name: unique('Redactor'), systemPrompt: '[[ritmo:60]]' });
    const name = unique('Flujo e2e');

    await page.goto('/workflows');
    await page.getByRole('link', { name: 'Nuevo workflow' }).click();
    await expect(page).toHaveURL(/\/workflows\/new$/);
    await page.getByLabel('Nombre del workflow').fill(name);

    // Recién creado: la salida no recibe nada, así que la validación no está en verde.
    const badge = page.locator('.check-badge');
    await expect(badge).not.toHaveText(/Válido/);
    await expect(page.locator('.vue-flow__node')).toHaveCount(2);

    // 1) Añadir un agente con clic en la paleta (sin nada seleccionado: queda suelto) y unirlo a mano a la entrada.
    const palette = page.getByLabel('Paleta de nodos');
    await palette.getByRole('button', { name: analista.name }).click();
    await expect(page.locator('.vue-flow__node')).toHaveCount(3);
    const analistaNode = page.locator('.vue-flow__node').filter({ hasText: analista.name });
    const analistaId = (await analistaNode.getAttribute('data-id'))!;
    await expect(page.locator('.vue-flow__edge')).toHaveCount(0);
    await connect(page, node(page, 'entrada'), analistaNode);
    await expect(page.locator('.vue-flow__edge')).toHaveCount(1);

    // 2) Con el analista seleccionado, el siguiente agente se coloca a su derecha y se conecta solo.
    await analistaNode.click();
    const inspector = page.getByLabel('Propiedades');
    await expect(inspector.getByRole('heading', { name: 'Agente' })).toBeVisible();
    await palette.getByRole('button', { name: redactor.name }).click();
    await expect(page.locator('.vue-flow__edge')).toHaveCount(2);
    const redactorNode = page.locator('.vue-flow__node').filter({ hasText: redactor.name });
    const redactorId = (await redactorNode.getAttribute('data-id'))!;

    // 3) Inspector: la tarea del redactor cita al analista con una referencia insertada desde los chips.
    await inspector.getByLabel('Etiqueta').fill('Redactar resumen');
    await expect(redactorNode).toContainText('Redactar resumen');
    const task = inspector.locator('#in-prompt');
    await task.fill('Resume esto: ');
    await task.press('End');
    await inspector.getByRole('button', { name: `{{${analistaId}}}` }).click();
    await expect(task).toHaveValue(`Resume esto: {{${analistaId}}}`);
    await inspector.getByLabel('Reintentos').fill('2');

    // 4) Un ciclo se rechaza con un aviso y no crea la conexión.
    await connect(page, redactorNode, analistaNode);
    await expect(toast(page, 'crearía un ciclo')).toBeVisible();
    await expect(page.locator('.vue-flow__edge')).toHaveCount(2);

    // 5) Unir el redactor con la salida a mano: el workflow pasa a ser válido.
    await connect(page, redactorNode, node(page, 'salida'));
    await expect(page.locator('.vue-flow__edge')).toHaveCount(3);
    await expect(badge).toHaveText(/Válido/);

    // 6) Arrastrar un bloque desde la paleta crea un nodo suelto que la validación señala; al borrarlo vuelve a ser válido.
    await palette.getByRole('button', { name: 'Transformación' }).dragTo(page.locator('.vue-flow__pane'), { targetPosition: { x: 420, y: 620 } });
    await expect(page.locator('.vue-flow__node')).toHaveCount(5);
    await expect(badge).not.toHaveText(/Válido/);
    await badge.click();
    await expect(inspector.locator('.validation .issue').first()).toBeVisible();
    await page.locator('.vue-flow__node').filter({ hasText: 'Transformación' }).click();
    await inspector.getByRole('button', { name: 'Eliminar nodo' }).click();
    await expect(page.locator('.vue-flow__node')).toHaveCount(4);
    await expect(badge).toHaveText(/Válido/);

    // 7) Guardar: URL definitiva y definición persistida tal como se construyó.
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(toast(page, 'Workflow guardado.')).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\/wf_/);
    const wfId = page.url().split('/').pop()!;
    const saved = await app.api('GET', `/api/workflows/${wfId}`);
    expect(saved.name).toBe(name);
    expect(saved.nodes.map((n: any) => n.id).sort()).toEqual(['entrada', 'salida', analistaId, redactorId].sort());
    expect(saved.edges.map((e: any) => `${e.source}>${e.target}`).sort()).toEqual(
      [`entrada>${analistaId}`, `${analistaId}>${redactorId}`, `${redactorId}>salida`].sort(),
    );
    const redactorSaved = saved.nodes.find((n: any) => n.id === redactorId);
    expect(redactorSaved).toMatchObject({ label: 'Redactar resumen', config: { agentId: redactor.id, prompt: `Resume esto: {{${analistaId}}}`, retries: 2 } });

    // 8) Ejecutar y observar el monitor en vivo.
    await page.getByRole('button', { name: 'Ejecutar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ejecutar workflow' });
    await dialog.getByLabel('Entrada del workflow').fill('Ventas del tercer trimestre');
    await dialog.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(page).toHaveURL(/\/runs\/run_/);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

    const status = page.locator('.page-header .badge').first();
    await expect(status).toHaveText('En curso');
    await expect(page.getByRole('progressbar', { name: 'Progreso' })).toBeVisible();
    // Texto del modelo apareciendo en directo y nodo del grafo marcado como en curso.
    await expect(page.locator('.stream .output').first()).toContainText('palabra-5');
    await expect(page.locator(`.graph .vue-flow__node[data-id="${analistaId}"] .flow-node`)).toHaveClass(/st-running/);
    await expect(page.getByRole('button', { name: 'Cancelar' })).toBeVisible();

    await expect(status).toHaveText('Completado', { timeout: 30_000 });
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    for (const id of ['entrada', analistaId, redactorId, 'salida']) {
      await expect(page.locator(`.graph .vue-flow__node[data-id="${id}"] .flow-node`)).toHaveClass(/st-completed/);
    }
    // El redactor recibió la salida real del analista a través de la plantilla.
    await expect(page.locator('.panel .output')).toContainText('Eco: Resume esto: palabra-1 palabra-2');
    const steps = page.getByLabel('Pasos').locator('.step');
    await expect(steps).toHaveCount(5); // resumen + 4 pasos

    // Detalle de un paso: entrada ya resuelta y actividad filtrada.
    await steps.filter({ hasText: 'Redactar resumen' }).click();
    await page.getByRole('tab', { name: 'Entrada' }).click();
    await expect(page.locator('.panel .codeblock')).toContainText('Resume esto: palabra-1');
    await page.getByRole('tab', { name: /Actividad/ }).click();
    await expect(page.locator('.panel .activity li.message')).toHaveCount(1);
  });

  test('editar un workflow existente: ramas de una condición y aviso de cambios sin guardar', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Juez') });
    const wf = await app.createWorkflow(
      unique('Con ramas'),
      [
        { id: 'entrada', type: 'input' },
        { id: 'juez', type: 'agent', config: { agentId: agent.id, prompt: '[[decir:APROBADO]] {{input}}' } },
        { id: 'salida', type: 'output', config: { template: '{{juez}}' } },
      ],
      ['entrada>juez', 'juez>salida'],
    );
    await page.goto(`/workflows/${wf.id}`);
    await expect(page.locator('.check-badge')).toHaveText(/Válido/);
    await expect(page.getByRole('button', { name: 'Guardar' })).toBeDisabled();

    // Añadir una condición tras el juez y conectar su rama «no» a un nuevo nodo de salida.
    await node(page, 'juez').click();
    const palette = page.getByLabel('Paleta de nodos');
    await palette.getByRole('button', { name: 'Condición' }).click();
    const inspector = page.getByLabel('Propiedades');
    await expect(inspector.getByRole('heading', { name: 'Condición' })).toBeVisible();
    await inspector.getByLabel('Valor').fill('APROBADO');
    const cond = page.locator('.vue-flow__node').filter({ hasText: '¿Condición?' });
    await expect(cond).toContainText('contiene «APROBADO»');

    await palette.getByRole('button', { name: 'Salida' }).click();
    // Desde una condición, el primer nodo añadido ocupa la rama «sí» y el segundo la rama «no».
    await expect(page.locator('.vue-flow__edge.branch-true')).toHaveCount(1);
    await cond.click();
    await palette.getByRole('button', { name: 'Transformación' }).click();
    await expect(page.locator('.vue-flow__edge.branch-false')).toHaveCount(1);
    // Un tercer nodo ya no tiene rama libre: queda suelto y se une a mano desde la rama «no».
    await cond.click();
    await palette.getByRole('button', { name: 'Salida' }).click();
    const loose = page.locator('.vue-flow__node:has(.flow-node.selected)');
    await expect(loose).toBeInViewport({ ratio: 1 });
    await connect(page, cond, loose, '.vue-flow__handle.h-false');
    await expect(page.locator('.vue-flow__edge.branch-false')).toHaveCount(2);
    await expect(page.getByText('Sin guardar')).toBeVisible();

    // Salir con cambios pendientes pide confirmación.
    await page.getByRole('link', { name: 'Volver a workflows' }).click();
    const leave = page.getByRole('dialog', { name: 'Cambios sin guardar' });
    await leave.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(toast(page, 'Workflow guardado.')).toBeVisible();

    const saved = await app.api('GET', `/api/workflows/${wf.id}`);
    const condNode = saved.nodes.find((n: any) => n.type === 'condition');
    expect(condNode.config).toMatchObject({ operator: 'contains', right: 'APROBADO' });
    expect(saved.edges.some((e: any) => e.source === condNode.id && e.sourceHandle === 'false')).toBe(true);
  });

  test('no deja ejecutar un workflow con errores y lleva al nodo que falla', async ({ page }) => {
    await page.goto('/workflows/new');
    await page.getByLabel('Paleta de nodos').getByRole('button', { name: 'Herramienta' }).click();
    await page.locator('.vue-flow__pane').click({ position: { x: 30, y: 30 } });
    await page.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(toast(page, /Corrige/)).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Ejecutar workflow' })).toHaveCount(0);
    await expect(page.getByLabel('Propiedades').locator('.callout.danger').first()).toBeVisible();
  });
});
