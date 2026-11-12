import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, toast, unique } from './support/fixtures';

// Servidor MCP real (SDK oficial) que AgentForge arranca como proceso hijo.
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'test', 'fixtures', 'mcp-server.mjs');

test.describe('Servidores MCP', () => {
  test('añadir un servidor, probar una de sus herramientas, dársela a un agente y quitarlo', async ({ page, app }) => {
    const name = `m${Date.now().toString(36).slice(-6)}`;
    await page.goto('/tools');
    await page.getByRole('tab', { name: 'Servidores MCP' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Servidores MCP' });
    // Solo se ve el panel de la pestaña elegida.
    await expect(page.getByRole('tabpanel')).toHaveCount(1);

    await panel.getByRole('button', { name: 'Añadir servidor MCP' }).first().click();
    const form = page.getByRole('dialog', { name: 'Añadir servidor MCP' });
    // El nombre es el prefijo de las herramientas: se valida.
    await form.getByLabel('Nombre', { exact: true }).fill('Con Espacios');
    await form.getByLabel('Programa').fill(process.execPath);
    await form.getByRole('button', { name: 'Añadir y conectar' }).click();
    await expect(form.getByRole('alert')).toContainText('letras minúsculas');
    await form.getByLabel('Nombre', { exact: true }).fill(name);
    await form.getByLabel('Argumentos').fill(FIXTURE);
    await form.getByLabel('Variables de entorno').fill('CLAVE_SECRETA=valor-e2e');
    await form.getByRole('button', { name: 'Añadir y conectar' }).click();
    await expect(toast(page, `Servidor «${name}» conectado: 7 herramientas disponibles.`)).toBeVisible();

    const card = panel.getByRole('listitem').filter({ hasText: name });
    await expect(card.getByText('Conectado', { exact: true })).toBeVisible();
    await expect(card).toContainText(`${name}__sumar`);
    // El valor secreto no vuelve a la interfaz.
    await expect(page.getByText('valor-e2e')).toHaveCount(0);
    await card.getByRole('button', { name: 'Editar' }).click();
    const edit = page.getByRole('dialog', { name: `Editar el servidor «${name}»` });
    await expect(edit.getByLabel('Variables de entorno')).toHaveValue('');
    await expect(edit.getByText('Sustituir las guardadas (CLAVE_SECRETA)')).toBeVisible();
    await edit.getByRole('button', { name: 'Cancelar' }).click();

    // Sus herramientas están en el catálogo y se pueden probar.
    await page.getByRole('tab', { name: 'Catálogo' }).click();
    await page.getByLabel('Buscar herramientas').fill(`${name}__sumar`);
    const tool = page.locator('article.tool').filter({ hasText: `${name}__sumar` });
    await expect(tool.getByText('MCP', { exact: true })).toBeVisible();
    await tool.getByRole('button', { name: 'Probar sumar' }).click();
    const bench = page.getByRole('dialog', { name: 'Probar sumar' });
    await bench.locator('#tt-a').fill('19');
    await bench.locator('#tt-b').fill('23');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.locator('.codeblock')).toContainText('42');
    await bench.getByRole('button', { name: 'Cerrar' }).first().click();

    // Un agente la usa en una ejecución real (el modelo simulado pide la herramienta y recibe el resultado).
    const agent = await app.createAgent({
      name: unique('Con MCP'),
      tools: [`${name}__sumar`],
      systemPrompt: `[[herramienta:${name}__sumar {"a": 40, "b": 2}]]`,
    });
    const run = await app.runToEnd('agents', agent.id, 'suma');
    expect(run.status).toBe('completed');
    expect(run.output).toContain(`Resultado de ${name}__sumar: 42`);

    // Desactivarlo retira sus herramientas del catálogo; eliminarlo pide confirmación.
    await page.getByRole('tab', { name: 'Servidores MCP' }).click();
    await card.getByRole('button', { name: 'Editar' }).click();
    await edit.getByText('Servidor activo').click();
    await edit.getByRole('button', { name: 'Guardar y conectar' }).click();
    await expect(toast(page, `Servidor «${name}» guardado, pero desactivado.`)).toBeVisible();
    await expect(card.getByText('Desactivado', { exact: true })).toBeVisible();
    expect((await app.api<any[]>('GET', '/api/tools')).filter((t) => t.source === 'mcp' && t.mcpServerName === name)).toEqual([]);

    await card.getByRole('button', { name: `Eliminar el servidor ${name}` }).click();
    await page.getByRole('dialog', { name: 'Eliminar servidor MCP' }).getByRole('button', { name: 'Eliminar servidor' }).click();
    await expect(toast(page, `Servidor «${name}» eliminado.`)).toBeVisible();
    await expect(card).toHaveCount(0);
  });

  test('un servidor que no arranca queda señalado con el motivo y se puede reintentar', async ({ page, app }) => {
    const name = `r${Date.now().toString(36).slice(-6)}`;
    await page.goto('/tools');
    await page.getByRole('tab', { name: 'Servidores MCP' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Servidores MCP' });
    await panel.getByRole('button', { name: 'Añadir servidor MCP' }).first().click();
    const form = page.getByRole('dialog', { name: 'Añadir servidor MCP' });
    await form.getByLabel('Nombre', { exact: true }).fill(name);
    await form.getByLabel('Programa').fill(process.execPath);
    await form.getByLabel('Argumentos').fill(`${FIXTURE}\n--romper`);
    await form.getByRole('button', { name: 'Añadir y conectar' }).click();
    await expect(toast(page, `Servidor «${name}» guardado, pero no se pudo conectar`)).toBeVisible();
    const card = panel.getByRole('listitem').filter({ hasText: name });
    await expect(card.getByText('Sin conexión', { exact: true })).toBeVisible();
    await expect(card.getByRole('alert')).toContainText('configuración incompleta: falta la clave');

    await card.getByRole('button', { name: 'Reconectar' }).click();
    await expect(toast(page, `No se pudo conectar con «${name}»`)).toBeVisible();
    const id = (await app.api<any[]>('GET', '/api/mcp/servers')).find((s) => s.name === name).id;
    await app.api('DELETE', `/api/mcp/servers/${id}`);
  });
});
