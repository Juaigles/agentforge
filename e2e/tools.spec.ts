import type { Page } from '@playwright/test';
import { expect, startLocalApi, test, toast, unique, type LocalApi } from './support/fixtures';

const toolName = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const card = (page: Page, name: string) => page.locator('article.tool').filter({ has: page.locator('code', { hasText: new RegExp(`^${name}$`) }) });

test.describe('Herramientas', () => {
  let local: LocalApi;
  test.beforeEach(async () => {
    local = await startLocalApi();
  });
  test.afterEach(async () => {
    await local.close();
  });

  test('herramienta HTTP personalizada: alta, prueba, uso real por un agente, edición y borrado', async ({ page, app }) => {
    const name = toolName('stock');
    await page.goto('/tools');
    await page.getByRole('button', { name: 'Nueva herramienta HTTP' }).click();
    const editor = page.getByRole('dialog', { name: 'Nueva herramienta HTTP' });

    // Validación: nada se envía con el formulario vacío.
    await editor.getByRole('button', { name: 'Crear herramienta' }).click();
    await expect(editor.getByText('El nombre es obligatorio.')).toBeVisible();
    await expect(editor.getByText('La URL es obligatoria.')).toBeVisible();
    await editor.locator('#te-name').fill('Nombre Malo');
    await expect(editor.getByText('Usa minúsculas, números y guiones bajos')).toBeVisible();

    await editor.locator('#te-name').fill(name);
    await editor.locator('#te-desc').fill('Consulta las unidades en stock de un producto en un almacén.');
    await editor.getByLabel('URL').fill(`${local.url}/stock?producto={{producto}}&almacen={{almacen}}`);
    // Los huecos sin parámetro declarado se avisan.
    await expect(editor.getByText('no hay ningún parámetro con ese nombre')).toBeVisible();

    await editor.getByRole('button', { name: 'Añadir cabecera' }).click();
    await editor.getByLabel('Nombre de la cabecera 1').fill('X-Origen');
    await editor.getByLabel('Valor de la cabecera 1').fill('agentforge-e2e');

    const rows = editor.locator('.param-row');
    await editor.getByRole('button', { name: 'Añadir parámetro' }).click();
    await rows.nth(0).getByLabel('Nombre').fill('producto');
    await rows.nth(0).getByLabel('Descripción').fill('Nombre del producto');

    await editor.getByRole('button', { name: 'Añadir parámetro' }).click();
    await rows.nth(1).getByLabel('Nombre').fill('almacen');
    await rows.nth(1).getByLabel('Obligatorio').uncheck();
    await rows.nth(1).getByLabel('Valores permitidos').fill('norte, sur');
    await rows.nth(1).getByLabel('Valor por defecto').fill('centro');
    await expect(rows.nth(1).getByRole('alert')).toHaveText('El valor por defecto debe ser uno de los valores permitidos.');
    await rows.nth(1).getByLabel('Valor por defecto').fill('sur');
    await expect(rows.nth(1).getByRole('alert')).toHaveCount(0);
    await expect(editor.getByText('no hay ningún parámetro con ese nombre')).toHaveCount(0);

    // Un tipo numérico exige valores numéricos; los tipos sin lista de valores la desactivan.
    await editor.getByRole('button', { name: 'Añadir parámetro' }).click();
    await rows.nth(2).getByLabel('Nombre').fill('minimo');
    await rows.nth(2).getByLabel('Tipo').selectOption('integer');
    await rows.nth(2).getByLabel('Valores permitidos').fill('1, dos');
    await expect(rows.nth(2).getByRole('alert')).toContainText('«dos» no es un número');
    await rows.nth(2).getByLabel('Tipo').selectOption('boolean');
    await expect(rows.nth(2).getByLabel('Valores permitidos')).toBeDisabled();
    await editor.getByRole('button', { name: 'Quitar el parámetro minimo' }).click();
    await expect(rows).toHaveCount(2);

    await editor.getByRole('button', { name: 'Crear herramienta' }).click();
    await expect(toast(page, `Herramienta «${name}» creada`)).toBeVisible();
    await expect(editor).toHaveCount(0);

    // Lo guardado es exactamente el esquema construido.
    const tools = await app.api<any[]>('GET', '/api/tools');
    const saved = tools.find((t) => t.name === name);
    expect(saved.parameters).toEqual({
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre del producto' },
        almacen: { type: 'string', enum: ['norte', 'sur'], default: 'sur' },
      },
      required: ['producto'],
    });
    const tool = card(page, name);
    await expect(tool.getByText('Personalizada')).toBeVisible();
    await expect(tool).toContainText('Valores: norte, sur.');
    await expect(tool).toContainText('Por defecto: sur.');
    await expect(tool).toContainText('Sin uso');

    // Con las redes privadas bloqueadas (por defecto) la llamada a 127.0.0.1 se rechaza.
    await tool.getByRole('button', { name: `Probar ${name}` }).click();
    let bench = page.getByRole('dialog', { name: `Probar ${name}` });
    await bench.getByLabel('producto').fill('tornillo');
    // El parámetro con valores permitidos es un desplegable con el valor por defecto elegido.
    await expect(bench.getByLabel('almacen')).toHaveValue('sur');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('La herramienta devolvió un error')).toBeVisible();
    await expect(bench.locator('.codeblock')).toContainText('Acceso bloqueado a red privada o local');
    expect(local.requests).toHaveLength(0);
    await bench.getByRole('button', { name: 'Cerrar' }).first().click();

    // Se permite en Ajustes (con confirmación) y entonces la herramienta llama de verdad a la API local.
    await page.getByRole('link', { name: 'Ajustes', exact: true }).first().click();
    await page.getByLabel('Permitir redes privadas').check();
    await page.getByRole('dialog', { name: 'Permitir redes privadas' }).getByRole('button', { name: 'Permitir' }).click();
    await expect(toast(page, 'Acceso a redes privadas permitido.')).toBeVisible();
    expect((await app.api('GET', '/api/settings')).allowPrivateNetwork).toBe(true);

    await page.getByRole('link', { name: 'Herramientas' }).click();
    await card(page, name)
      .getByRole('button', { name: `Probar ${name}` })
      .click();
    bench = page.getByRole('dialog', { name: `Probar ${name}` });
    await bench.getByLabel('producto').fill('tornillo');
    await bench.getByLabel('almacen').selectOption('norte');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('Ejecutada correctamente')).toBeVisible();
    await expect(bench.locator('.codeblock')).toContainText('"unidades": 42');
    expect(local.requests.at(-1)).toMatchObject({ method: 'GET', url: '/stock?producto=tornillo&almacen=norte' });
    expect(local.requests.at(-1)!.headers['x-origen']).toBe('agentforge-e2e');
    await bench.getByRole('button', { name: 'Cerrar' }).first().click();

    // Uso real por un agente: el modelo pide la herramienta, AgentForge llama a la API y le devuelve el resultado.
    const agent = await app.createAgent({ name: unique('Almacenero'), tools: [name] });
    await page.goto(`/agents/${agent.id}`);
    await expect(page.getByRole('checkbox', { name: new RegExp(name) })).toBeChecked();
    const playground = page.locator('.playground');
    await playground.getByLabel('Tarea').fill(`[[herramienta:${name} {"producto":"tuerca M8"}]] ¿Cuántas quedan?`);
    await playground.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(playground.locator('.card-head .badge')).toHaveText('Completado');
    await expect(playground.locator('.answer')).toContainText('"unidades": 42');
    // El agente no envió «almacen»: se aplicó el valor por defecto, y el producto viaja codificado.
    expect(local.requests.at(-1)!.url).toBe('/stock?producto=tuerca%20M8&almacen=sur');
    expect(app.fake.chats.find((c) => c.user.includes('tuerca M8'))?.toolNames).toEqual([name]);

    // Edición: se cargan los valores guardados y se cambian los permitidos y el valor por defecto.
    await page.goto('/tools');
    await expect(card(page, name)).toContainText('1 agente');
    await page.getByRole('button', { name: `Editar ${name}` }).click();
    const edit = page.getByRole('dialog', { name: 'Editar herramienta HTTP' });
    await expect(edit.locator('#te-name')).toHaveValue(name);
    await expect(edit.getByLabel('Valor de la cabecera 1')).toHaveValue('agentforge-e2e');
    const editRows = edit.locator('.param-row');
    await expect(editRows.nth(1).getByLabel('Valores permitidos')).toHaveValue('norte, sur');
    await expect(editRows.nth(1).getByLabel('Valor por defecto')).toHaveValue('sur');
    await expect(editRows.nth(1).getByLabel('Obligatorio')).not.toBeChecked();
    await editRows.nth(1).getByLabel('Valores permitidos').fill('norte, sur, este');
    await editRows.nth(1).getByLabel('Valor por defecto').fill('este');
    await edit.locator('#te-desc').fill('Consulta el stock (versión 2).');
    await edit.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(toast(page, `Herramienta «${name}» actualizada.`)).toBeVisible();
    await expect(card(page, name)).toContainText('Valores: norte, sur, este.');
    await expect(card(page, name)).toContainText('Por defecto: este.');
    await expect(card(page, name)).toContainText('Consulta el stock (versión 2).');

    // Desactivarla la retira del motor sin borrarla.
    await page.getByRole('button', { name: `Editar ${name}` }).click();
    await page.getByRole('dialog', { name: 'Editar herramienta HTTP' }).locator('input.switch').uncheck();
    await page.getByRole('dialog', { name: 'Editar herramienta HTTP' }).getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(card(page, name).getByText('Desactivada')).toBeVisible();
    await expect(card(page, name).getByRole('button', { name: `Probar ${name}` })).toBeDisabled();
    const before = local.requests.length;
    const offRun = await app.runToEnd('agents', agent.id, `[[herramienta:${name} {"producto":"x"}]]`);
    expect(offRun.status).toBe('completed');
    expect(local.requests.length).toBe(before); // el modelo ya no la recibe

    // Borrado: avisa de qué agentes la usan.
    await page.getByRole('button', { name: `Eliminar ${name}` }).click();
    const confirm = page.getByRole('dialog', { name: `Eliminar «${name}»` });
    await expect(confirm).toContainText(`La usan 1 agente (${agent.name})`);
    await confirm.getByRole('button', { name: 'Eliminar' }).click();
    await expect(toast(page, `Herramienta «${name}» eliminada.`)).toBeVisible();
    await expect(card(page, name)).toHaveCount(0);
    expect((await app.api<any[]>('GET', '/api/tools')).some((t) => t.name === name)).toBe(false);

    // El agente lo refleja: avisa de la herramienta desaparecida.
    await page.goto(`/agents/${agent.id}`);
    await expect(page.getByText(`Herramientas que ya no existen y se quitarán al guardar: ${name}.`)).toBeVisible();
  });

  test('herramienta con método POST y plantilla de cuerpo', async ({ page, app }) => {
    await app.api('PUT', '/api/settings', { allowPrivateNetwork: true });
    const name = toolName('pedido');
    await page.goto('/tools');
    await page.getByRole('button', { name: 'Nueva herramienta HTTP' }).click();
    const editor = page.getByRole('dialog', { name: 'Nueva herramienta HTTP' });
    await editor.locator('#te-name').fill(name);
    await editor.locator('#te-desc').fill('Registra un pedido en el sistema interno.');
    // El cuerpo solo se ofrece para los métodos que lo admiten.
    await expect(editor.getByLabel('Plantilla del cuerpo')).toHaveCount(0);
    await editor.getByLabel('Método').selectOption('POST');
    await editor.getByLabel('URL').fill(`${local.url}/pedidos`);
    await editor.getByLabel('Plantilla del cuerpo').fill('{ "articulo": "{{articulo}}", "cantidad": {{cantidad}} }');
    const rows = editor.locator('.param-row');
    await editor.getByRole('button', { name: 'Añadir parámetro' }).click();
    await rows.nth(0).getByLabel('Nombre').fill('articulo');
    await editor.getByRole('button', { name: 'Añadir parámetro' }).click();
    await rows.nth(1).getByLabel('Nombre').fill('cantidad');
    await rows.nth(1).getByLabel('Tipo').selectOption('integer');
    await rows.nth(1).getByLabel('Valor por defecto').fill('1');
    await rows.nth(1).getByLabel('Obligatorio').uncheck();
    await editor.getByRole('button', { name: 'Crear herramienta' }).click();
    await expect(toast(page, 'creada')).toBeVisible();

    await card(page, name)
      .getByRole('button', { name: `Probar ${name}` })
      .click();
    const bench = page.getByRole('dialog', { name: `Probar ${name}` });
    await bench.getByLabel('articulo').fill('arandela');
    await expect(bench.getByLabel('cantidad')).toHaveValue('1');
    await bench.getByLabel('cantidad').fill('uno');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('Debe ser un número.')).toBeVisible();
    await bench.getByLabel('cantidad').fill('7');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('Ejecutada correctamente')).toBeVisible();
    const sent = local.requests.at(-1)!;
    expect(sent).toMatchObject({ method: 'POST', url: '/pedidos' });
    expect(JSON.parse(sent.body)).toEqual({ articulo: 'arandela', cantidad: 7 });
    expect(sent.headers['content-type']).toBe('application/json');

    await app.api('DELETE', `/api/tools/custom/${(await app.api<any[]>('GET', '/api/tools')).find((t) => t.name === name).customId}`);
  });

  test('el nombre de una herramienta no puede repetirse ni pisar una integrada', async ({ page }) => {
    await page.goto('/tools');
    await page.getByRole('button', { name: 'Nueva herramienta HTTP' }).click();
    const editor = page.getByRole('dialog', { name: 'Nueva herramienta HTTP' });
    await editor.locator('#te-name').fill('calculator');
    await editor.locator('#te-desc').fill('Intento de suplantar la calculadora.');
    await editor.getByLabel('URL').fill('https://example.com/calc');
    await editor.getByRole('button', { name: 'Crear herramienta' }).click();
    await expect(editor.getByRole('alert').filter({ hasText: 'es el nombre de una herramienta integrada' })).toBeVisible();
    // El formulario sigue abierto con lo escrito.
    await expect(editor.getByLabel('URL')).toHaveValue('https://example.com/calc');
    await editor.getByRole('button', { name: 'Cancelar' }).click();
    await expect(editor).toHaveCount(0);
  });

  test('catálogo: búsqueda y banco de pruebas de las herramientas integradas', async ({ page }) => {
    await page.goto('/tools');
    await expect(page.locator('article.tool')).toHaveCount(11);
    const search = page.getByLabel('Buscar herramientas');
    await search.fill('fecha');
    await expect(page.locator('article.tool')).toHaveCount(1);
    await expect(page.locator('article.tool')).toContainText('current_datetime');
    await search.fill('zzz-no-existe');
    await expect(page.getByRole('heading', { name: 'Ninguna herramienta coincide' })).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
    await expect(page.locator('article.tool')).toHaveCount(11);

    await page.getByRole('button', { name: 'Probar Calculadora' }).click();
    const bench = page.getByRole('dialog', { name: 'Probar Calculadora' });
    await bench.getByLabel('expression').fill('round(2450.80 * 1.21, 2)');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.locator('.codeblock')).toContainText('2965.47');
    // Un error de la herramienta se muestra sin romper el formulario.
    await bench.getByLabel('expression').fill('2 +* 3');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('La herramienta devolvió un error')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(bench).toHaveCount(0);
  });

  test('espacio de trabajo: los archivos que escriben las herramientas se ven, se previsualizan y se borran', async ({ page, app }) => {
    const folder = `e2e-${Date.now().toString(36)}`;
    const md = `${folder}/informe.md`;
    const txt = `${folder}/notas.txt`;

    // El archivo Markdown lo escribe un agente con la herramienta real file_write.
    const agent = await app.createAgent({ name: unique('Escriba'), tools: ['file_write'] });
    const content = '# Informe trimestral\\n\\nVentas **al alza** un 12 %.';
    const run = await app.runToEnd('agents', agent.id, `[[herramienta:file_write {"path":"${md}","content":"${content}"}]] guarda el informe`);
    expect(run.status).toBe('completed');

    // El de texto se crea desde el banco de pruebas de la interfaz.
    await page.goto('/tools');
    await page.getByRole('button', { name: 'Probar Escribir archivo' }).click();
    const bench = page.getByRole('dialog', { name: 'Probar Escribir archivo' });
    await bench.getByLabel('path').fill(txt);
    await bench.getByLabel('content').fill('línea uno\nlínea dos');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('Ejecutada correctamente')).toBeVisible();
    // Las rutas que salen del espacio de trabajo se rechazan.
    await bench.getByLabel('path').fill('../fuera.txt');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('La herramienta devolvió un error')).toBeVisible();
    await bench.getByRole('button', { name: 'Cerrar' }).first().click();

    await page.getByRole('tab', { name: /Archivos/ }).click();
    const rows = page.locator('tbody tr');
    const mdRow = rows.filter({ hasText: md });
    const txtRow = rows.filter({ hasText: txt });
    await expect(mdRow).toHaveCount(1);
    await expect(txtRow).toHaveCount(1);

    // Markdown: vista previa renderizada y alternancia con el texto original.
    await mdRow
      .getByRole('button', { name: `Ver ${md}` })
      .first()
      .click();
    const viewer = page.getByRole('dialog', { name: md });
    await expect(viewer.getByRole('heading', { name: 'Informe trimestral' })).toBeVisible();
    await expect(viewer.locator('strong')).toHaveText('al alza');
    await viewer.getByRole('button', { name: 'Texto' }).click();
    await expect(viewer.locator('.codeblock')).toContainText('# Informe trimestral');
    await expect(viewer.locator('.codeblock')).toContainText('**al alza**');
    await viewer.getByRole('button', { name: 'Cerrar' }).first().click();

    // Texto plano: sin selector de modo, contenido literal.
    await txtRow
      .getByRole('button', { name: `Ver ${txt}` })
      .first()
      .click();
    const plain = page.getByRole('dialog', { name: txt });
    await expect(plain.locator('.codeblock')).toHaveText('línea uno\nlínea dos');
    await expect(plain.getByRole('group', { name: 'Modo de visualización' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Borrado con confirmación: cancelar no borra; confirmar sí.
    await page.getByRole('button', { name: `Eliminar ${txt}` }).click();
    await page.getByRole('dialog', { name: 'Eliminar archivo' }).getByRole('button', { name: 'Cancelar' }).click();
    await expect(txtRow).toHaveCount(1);
    await page.getByRole('button', { name: `Eliminar ${txt}` }).click();
    await page.getByRole('dialog', { name: 'Eliminar archivo' }).getByRole('button', { name: 'Eliminar' }).click();
    await expect(toast(page, 'Archivo eliminado.')).toBeVisible();
    await expect(txtRow).toHaveCount(0);
    await expect(mdRow).toHaveCount(1);
    const files = (await app.api<Array<{ path: string }>>('GET', '/api/workspace/files')).map((f) => f.path.replace(/\\/g, '/'));
    expect(files).toContain(md);
    expect(files).not.toContain(txt);

    // «Actualizar» recoge lo que cambia fuera de la página.
    await app.api('DELETE', `/api/workspace/file?path=${encodeURIComponent(md)}`);
    await page.getByRole('button', { name: 'Actualizar' }).click();
    await expect(mdRow).toHaveCount(0);
  });
});
