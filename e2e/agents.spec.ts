import { expect, test, toast, unique } from './support/fixtures';

test.describe('Agentes', () => {
  test('crear un agente desde la interfaz y ejecutarlo en el banco de pruebas con una herramienta', async ({ page, app }) => {
    const name = unique('Contable');
    await page.goto('/agents');
    await page.getByRole('link', { name: 'Nuevo agente' }).click();
    await expect(page).toHaveURL(/\/agents\/new$/);

    // Validación en cliente: sin nombre no se guarda.
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(page.getByText('Ponle un nombre al agente.')).toBeVisible();

    await page.getByLabel('Nombre').fill(name);
    await page.getByLabel('Rol').fill('asistente numérico');
    await page.getByLabel('Instrucciones del sistema').fill('Calcula siempre con la calculadora.');
    // El modelo propuesto es el del proveedor de ejemplo, leído de la lista real del proveedor.
    await expect(page.locator('#ag-model')).toHaveValue('e2e-model');
    await expect(page.getByText('Capacidades: completion, tools, thinking.')).toBeVisible();
    await page.getByRole('checkbox', { name: /Calculadora/ }).check();
    await expect(page.getByText('1 activas')).toBeVisible();

    // Mientras no se guarda, el banco de pruebas ofrece «Guardar y ejecutar» (sin tarea todavía no hay qué lanzar).
    await expect(page.getByText('Lo que hay sin guardar se guarda antes de ejecutar.')).toBeVisible();
    await expect(page.locator('.playground').getByRole('button', { name: 'Guardar y ejecutar' })).toBeDisabled();

    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(toast(page, `«${name}» guardado.`)).toBeVisible();
    await expect(page).toHaveURL(/\/agents\/agt_/);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

    // Banco de pruebas: el modelo pide la calculadora y responde con su resultado.
    const playground = page.locator('.playground');
    await playground.getByLabel('Tarea').fill('[[herramienta:calculator {"expression":"2450.80 * 1.21"}]] ¿Cuál es el total con IVA?');
    await playground.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(playground.locator('.card-head .badge')).toHaveText('Completado');
    await expect(playground.locator('.answer')).toContainText('"result": 2965.468');

    await playground.getByText('Actividad y herramientas').click();
    const call = playground.locator('.activity li.tool').first();
    await expect(call).toContainText('calculator');
    await expect(call.locator('.badge')).toContainText('OK');
    await call.getByRole('button').click();
    await expect(call).toContainText('2450.80 * 1.21');
    await expect(call).toContainText('2965.468');

    await expect(playground.locator('.history .hist')).toHaveCount(1);

    // El servidor recibió la herramienta en el protocolo real y las instrucciones del agente.
    const first = app.fake.chats.find((c) => c.system.includes(name));
    expect(first?.toolNames).toEqual(['calculator']);
    expect(first?.system).toContain('asistente numérico');
    expect(first?.system).toContain('Calcula siempre con la calculadora.');

    // El agente aparece en la lista.
    await page.getByRole('link', { name: 'Volver a agentes' }).click();
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  });

  test('la respuesta llega en streaming y la ejecución se puede cancelar desde el banco de pruebas', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Lento') });
    await page.goto(`/agents/${agent.id}`);
    const playground = page.locator('.playground');
    await playground.getByLabel('Tarea').fill('[[lento]] escribe mucho');
    await playground.getByRole('button', { name: 'Ejecutar' }).click();

    await expect(playground.locator('.card-head .badge')).toHaveText('En curso');
    // El texto crece mientras el modelo sigue generando.
    await expect(playground.locator('.answer')).toContainText('palabra-3');
    await expect(playground.locator('.answer .caret')).toBeVisible();
    await expect(playground.getByLabel('Tarea')).toBeDisabled();
    const before = (await playground.locator('.answer').innerText()).length;
    await expect.poll(async () => (await playground.locator('.answer').innerText()).length).toBeGreaterThan(before);

    await playground.getByRole('button', { name: 'Cancelar' }).click();
    await expect(playground.locator('.card-head .badge')).toHaveText('Cancelado');
    await expect(playground.getByRole('button', { name: 'Ejecutar' })).toBeVisible();
    // Lo que ya se había generado sigue a la vista tras cancelar; el resto no llegó a escribirse.
    await expect(playground.locator('.answer')).toContainText('palabra-3');
    await expect(playground.locator('.answer')).not.toContainText('palabra-400');
  });

  test('avisa antes de perder cambios sin guardar, y permite editar, duplicar y eliminar', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Editable'), role: 'rol inicial' });
    await page.goto(`/agents/${agent.id}`);
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeDisabled();

    await page.getByLabel('Rol').fill('rol cambiado');
    await expect(page.getByText('Cambios sin guardar')).toBeVisible();
    await expect(page.locator('.playground').getByRole('button', { name: 'Guardar y ejecutar' })).toBeVisible();

    // Intento de salir: se pide confirmación y, al cancelar, se sigue en el editor.
    await page.getByRole('link', { name: 'Workflows' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cambios sin guardar' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));

    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(toast(page, 'guardado')).toBeVisible();
    expect((await app.api('GET', `/api/agents/${agent.id}`)).role).toBe('rol cambiado');

    await page.getByRole('button', { name: 'Duplicar agente' }).click();
    await expect(page).not.toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByLabel('Nombre')).toHaveValue(new RegExp(`^${agent.name}.*copia`, 'i'));
    await expect(page.getByLabel('Rol')).toHaveValue('rol cambiado');

    await page.getByRole('button', { name: 'Eliminar agente' }).click();
    await page.getByRole('dialog', { name: 'Eliminar agente' }).getByRole('button', { name: 'Eliminar' }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(toast(page, 'Agente eliminado.')).toBeVisible();
    const names = (await app.api<Array<{ name: string }>>('GET', '/api/agents')).map((a) => a.name);
    expect(names.filter((n) => n.startsWith(agent.name))).toEqual([agent.name]);
  });

  test('avisa si el modelo elegido no soporta herramientas', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('SinTools'), tools: ['calculator'] });
    await page.goto(`/agents/${agent.id}`);
    await page.locator('#ag-model').selectOption('e2e-sin-herramientas');
    await expect(page.getByText('no declara soporte de herramientas')).toBeVisible();
  });
});
