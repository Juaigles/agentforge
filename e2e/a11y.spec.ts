// Accesibilidad y edición del lienzo (hito 5, fase 6): teclado, foco, avisos, deshacer y estado de conexión.
import type { Page } from '@playwright/test';
import { expect, test, toast, unique } from './support/fixtures';

const node = (page: Page, id: string) => page.locator(`.vue-flow__node[data-id="${id}"]`);
const announcer = (page: Page) => page.getByTestId('announcer');

test.describe('Teclado y foco', () => {
  test('«Saltar al contenido» es la primera parada del tabulador y lleva el foco al contenido', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Agentes', level: 1 })).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Saltar al contenido' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#contenido')).toBeFocused();
    // La siguiente parada ya está dentro del contenido, no en el menú.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('main#contenido'))).toBe(true);
  });

  test('al cambiar de página el foco pasa al contenido, se anuncia la página y el desplazamiento vuelve arriba', async ({ page }) => {
    await page.goto('/glosario');
    await page.locator('main#contenido').evaluate((el) => (el.scrollTop = 600));
    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Agentes' }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.locator('main#contenido')).toBeFocused();
    await expect(announcer(page)).toHaveText('Página: Agentes');
    expect(await page.locator('main#contenido').evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('un diálogo atrapa el foco, deja inerte la página y, si es destructivo, empieza en «Cancelar»', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Foco') });
    const workflow = await app.createWorkflow(
      unique('Usa al agente'),
      [
        { id: 'entrada', type: 'input' },
        { id: 'paso', type: 'agent', config: { agentId: agent.id, prompt: '{{input}}' } },
        { id: 'salida', type: 'output', config: { template: '{{paso}}' } },
      ],
      ['entrada>paso', 'paso>salida'],
    );
    await page.goto('/agents');
    const trigger = page.getByRole('button', { name: `Eliminar ${agent.name}` });
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Eliminar agente' });
    // El aviso dice qué workflows dejarán de funcionar.
    await expect(dialog).toContainText(`Lo usa 1 workflow («${workflow.name}»), que dejará de poder ejecutarse`);
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(true);

    // El tabulador da la vuelta dentro del diálogo, en los dos sentidos.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Eliminar agente' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cerrar' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Eliminar agente' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Eliminar agente' })).toBeFocused();

    // Escape cierra, devuelve el foco a quien abrió el diálogo y no borra nada.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    expect((await app.api<Array<{ id: string }>>('GET', '/api/agents')).some((a) => a.id === agent.id)).toBe(true);
  });

  test('un aviso de error no desaparece solo y se anuncia como alerta; uno informativo sí caduca', async ({ page }) => {
    await page.goto('/workflows/new');
    await expect(page.locator('.vue-flow__node')).toHaveCount(2);
    await page.getByLabel('Nombre del workflow').fill('');
    await page.getByRole('button', { name: 'Guardar' }).click();
    const error = toast(page, 'Ponle un nombre al workflow.');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');

    // Un aviso informativo (copiar un nodo) convive con el error y caduca a los 5 s.
    await node(page, 'entrada').click();
    await page.keyboard.press('Control+c');
    const info = toast(page, 'Nodo copiado');
    await expect(info).toBeVisible();
    await expect(info).toHaveAttribute('role', 'status');
    await page.waitForTimeout(9000); // más que la vida antigua de un error (8 s)
    await expect(info).toBeHidden();
    await expect(error).toBeVisible();

    await error.getByRole('button', { name: 'Descartar aviso' }).click();
    await expect(error).toBeHidden();
  });
});

test.describe('Constructor sin ratón y con vuelta atrás', () => {
  test('deshacer y rehacer con los botones y con el teclado, también tras borrar un nodo', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Vuelta') });
    await page.goto('/workflows/new');
    const nodes = page.locator('.vue-flow__node');
    await expect(nodes).toHaveCount(2);
    const undo = page.getByRole('button', { name: 'Deshacer', exact: true });
    const redo = page.getByRole('button', { name: 'Rehacer', exact: true });
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();

    // Añadir un nodo es un paso que se puede deshacer y rehacer.
    await page.getByLabel('Paleta de nodos').getByRole('button', { name: agent.name }).click();
    await expect(nodes).toHaveCount(3);
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(nodes).toHaveCount(2);
    await expect(announcer(page)).toHaveText('Cambio deshecho.');
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(nodes).toHaveCount(3);

    // Escribir en un campo se agrupa en un solo paso; Ctrl+Z fuera de un campo lo deshace entero.
    const added = nodes.filter({ hasText: agent.name });
    await added.click();
    const label = page.locator('#in-label');
    await label.fill('Paso renombrado');
    await expect(added).toContainText('Paso renombrado');
    await page.waitForTimeout(500);
    await added.focus();
    await page.keyboard.press('Control+z');
    await expect(nodes.filter({ hasText: agent.name })).toHaveCount(1);
    await expect(nodes.filter({ hasText: 'Paso renombrado' })).toHaveCount(0);
    await page.keyboard.press('Control+Shift+z');
    await expect(nodes.filter({ hasText: 'Paso renombrado' })).toHaveCount(1);

    // Suprimir borra el nodo con su configuración; Ctrl+Z lo devuelve tal como estaba.
    await nodes.filter({ hasText: 'Paso renombrado' }).click();
    await page.locator('#in-prompt').fill('Tarea que no debe perderse');
    await page.waitForTimeout(500);
    await nodes.filter({ hasText: 'Paso renombrado' }).focus();
    await page.keyboard.press('Delete');
    await expect(nodes).toHaveCount(2);
    await page.keyboard.press('Control+z');
    await expect(nodes).toHaveCount(3);
    await nodes.filter({ hasText: 'Paso renombrado' }).click();
    await expect(page.locator('#in-prompt')).toHaveValue('Tarea que no debe perderse');
  });

  test('seleccionar, conectar y desconectar nodos solo con el teclado, y guardar con Ctrl+S', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Teclado') });
    const name = unique('Flujo por teclado');
    await page.goto('/workflows/new');
    await page.getByLabel('Nombre del workflow').fill(name);
    const edges = page.locator('.vue-flow__edge');
    const inspector = page.getByLabel('Propiedades');

    // El agente se añade suelto (clic en la paleta con el teclado: es un botón).
    const paletteButton = page.getByLabel('Paleta de nodos').getByRole('button', { name: agent.name });
    await paletteButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.vue-flow__node')).toHaveCount(3);
    await expect(edges).toHaveCount(0);
    await expect(announcer(page)).toContainText(`Nodo ${agent.name} añadido`);

    // Intro sobre un nodo enfocado abre sus propiedades y lleva allí el foco.
    const entrada = node(page, 'entrada');
    await entrada.focus();
    await expect(entrada).toHaveAttribute('aria-label', 'Entrada: Entrada');
    await page.keyboard.press('Enter');
    await expect(inspector.getByRole('heading', { name: 'Entrada' })).toBeVisible();
    await expect(page.locator('#in-label')).toBeFocused();

    // «Conexiones»: unir la entrada con el agente sin arrastrar.
    const connectTo = inspector.getByLabel('Conectar la salida de este nodo con');
    await connectTo.selectOption({ label: agent.name });
    await inspector.getByRole('button', { name: 'Conectar', exact: true }).click();
    await expect(edges).toHaveCount(1);
    await expect(announcer(page)).toHaveText(`Entrada conectado con ${agent.name}.`);
    await expect(inspector.getByLabel('Conexiones del nodo')).toContainText(`Envía a ${agent.name}`);

    // Escape desde las propiedades devuelve el foco al nodo.
    await page.locator('#in-label').focus();
    await page.keyboard.press('Escape');
    await expect(entrada).toBeFocused();

    // La lista «Nodos» de los ajustes llega a cualquier nodo sin pasar por el lienzo.
    await page.locator('.vue-flow__pane').click({ position: { x: 8, y: 8 } });
    await inspector.getByRole('list', { name: 'Nodos del workflow' }).getByRole('button', { name: agent.name }).click();
    await expect(page.locator('#in-label')).toBeFocused();
    await expect(page.locator('#in-label')).toHaveValue(agent.name);
    await page.locator('#in-prompt').fill('{{input}}');
    await connectTo.selectOption({ label: 'Salida' });
    await inspector.getByRole('button', { name: 'Conectar', exact: true }).click();
    await expect(edges).toHaveCount(2);
    // La conexión que crearía un ciclo no se ofrece.
    await expect(connectTo.locator('option', { hasText: 'Entrada' })).toHaveCount(0);

    // Quitar y rehacer una conexión desde la misma lista.
    await inspector.getByRole('button', { name: 'Quitar la conexión con Salida' }).click();
    await expect(edges).toHaveCount(1);
    await connectTo.selectOption({ label: 'Salida' });
    await inspector.getByRole('button', { name: 'Conectar', exact: true }).click();
    await expect(edges).toHaveCount(2);

    // Ctrl+S guarda aunque el foco esté en un campo.
    await page.locator('#in-prompt').focus();
    await page.keyboard.press('Control+s');
    await expect(toast(page, 'guardado')).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\/wf_/);
    const saved = (await app.api<Array<{ name: string; edges: Array<{ source: string; target: string }> }>>('GET', '/api/workflows')).find((w) => w.name === name)!;
    expect(saved.edges.map((e) => `${e.source}>${e.target}`).sort()).toHaveLength(2);
    expect(saved.edges.some((e) => e.source === 'entrada')).toBe(true);
    expect(saved.edges.some((e) => e.target === 'salida')).toBe(true);
  });

  test('copiar, pegar y ordenar los nodos', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Copiar') });
    await page.goto('/workflows/new');
    const nodes = page.locator('.vue-flow__node');
    await page.getByLabel('Paleta de nodos').getByRole('button', { name: agent.name }).click();
    await expect(nodes).toHaveCount(3);
    await nodes.filter({ hasText: agent.name }).first().focus();
    await page.keyboard.press('Control+c');
    await expect(toast(page, 'Nodo copiado')).toBeVisible();
    await page.keyboard.press('Control+v');
    await expect(nodes).toHaveCount(4);
    await page.keyboard.press('Control+d');
    await expect(nodes).toHaveCount(5);

    await page.getByRole('button', { name: 'Ordenar los nodos' }).click();
    await expect(announcer(page)).toHaveText('Nodos ordenados de izquierda a derecha.');
    // Tras ordenar, ningún nodo queda encima de otro.
    await page.waitForTimeout(400);
    const boxes = await nodes.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
        expect(overlap, `los nodos ${i} y ${j} se solapan`).toBe(false);
      }
    }
  });
});

test.describe('Historial y primera sesión', () => {
  test('los filtros del historial viven en la URL y sobreviven a recargar y a volver atrás', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Filtros'), systemPrompt: '[[decir:hecho]]' });
    const marker = unique('marca');
    const run = await app.runToEnd('agents', agent.id, marker);
    expect(run.status).toBe('completed');

    await page.goto('/runs');
    await page.getByRole('button', { name: 'Completadas' }).click();
    await page.getByLabel('Filtrar por tipo').selectOption('agent');
    await page.getByLabel('Buscar ejecuciones').fill(marker);
    await expect(page).toHaveURL(/estado=completed/);
    await expect(page).toHaveURL(/tipo=agent/);
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(marker).replace(/%20/g, '(%20|\\+)')}`));
    await expect(page.locator('tbody tr')).toHaveCount(1);

    // Abrir la ejecución y volver: los filtros siguen puestos.
    await page.locator('tbody tr').first().getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/runs/${run.id}$`));
    await page.goBack();
    await expect(page.getByRole('button', { name: 'Completadas' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Filtrar por tipo')).toHaveValue('agent');
    await expect(page.getByLabel('Buscar ejecuciones')).toHaveValue(marker);
    await expect(page.locator('tbody tr')).toHaveCount(1);

    // Recargar: igual. Y un valor desconocido en la URL se ignora.
    await page.reload();
    await expect(page.getByLabel('Buscar ejecuciones')).toHaveValue(marker);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.goto('/runs?estado=inventado&tipo=workflow');
    await expect(page.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Filtrar por tipo')).toHaveValue('workflow');
  });

  test('la guía de primeros pasos se marca sola al probar un agente y al completar un workflow, y se puede ocultar', async ({ page, app }) => {
    // Sin historial: quedan pendientes los pasos 2 y 3 (el modelo simulado responde, así que el 1 está hecho).
    await app.api('DELETE', '/api/runs');
    const agent = await app.createAgent({ name: unique('Guía'), systemPrompt: '[[decir:listo]]' });
    const workflow = await app.createWorkflow(
      unique('Guía wf'),
      [
        { id: 'entrada', type: 'input' },
        { id: 'paso', type: 'agent', config: { agentId: agent.id, prompt: '{{input}}' } },
        { id: 'salida', type: 'output', config: { template: '{{paso}}' } },
      ],
      ['entrada>paso', 'paso>salida'],
    );
    await page.goto('/');
    const guide = page.getByTestId('guide');
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('1 de 3 completados');
    await expect(guide.getByRole('heading', { name: /Conecta un modelo/ })).toContainText('hecho');
    await expect(guide.getByRole('heading', { name: /Prueba un agente/ })).toContainText('pendiente');

    // Los pasos se marcan en vivo, sin recargar.
    await app.runToEnd('agents', agent.id, 'hola');
    await expect(guide).toContainText('2 de 3 completados');
    await expect(guide.getByRole('heading', { name: /Prueba un agente/ })).toContainText('hecho');

    // Ocultarla es una preferencia que se recuerda.
    await guide.getByRole('button', { name: 'Ocultar guía' }).click();
    await expect(guide).toBeHidden();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Panel', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Indicadores' })).toBeVisible();
    await expect(guide).toBeHidden();

    // Al volver a mostrarla y completar un workflow, desaparece por haberse completado.
    await page.evaluate(() => localStorage.removeItem('agentforge.guide.hidden'));
    await page.reload();
    await expect(guide).toContainText('2 de 3 completados');
    const done = await app.runToEnd('workflows', workflow.id, 'hola');
    expect(done.status).toBe('completed');
    await expect(guide).toBeHidden();
  });

  test('si el servidor cae, la interfaz lo dice; al volver, se recupera sola', async ({ page, app }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Panel', level: 1 })).toBeVisible();
    const offline = page.getByTestId('offline');
    await expect(offline).toBeHidden();
    const status = page.locator('.sidebar .status');
    await expect(status).not.toContainText('sin conexión');

    await app.stop();
    await expect(offline).toBeVisible({ timeout: 15_000 });
    await expect(offline).toContainText('Sin conexión con el servidor de AgentForge');
    await expect(status).toContainText('Servidor sin conexión');

    await app.start();
    await expect(offline).toBeHidden({ timeout: 20_000 });
    await expect(toast(page, 'Conexión con el servidor recuperada.')).toBeVisible();
    await expect(status).not.toContainText('sin conexión');
  });
});
