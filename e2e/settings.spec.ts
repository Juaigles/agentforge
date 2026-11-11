import type { Page } from '@playwright/test';
import { expect, test, toast, unique } from './support/fixtures';

const providerRow = (page: Page, name: string) => page.locator('ul.providers > li').filter({ has: page.locator('.p-name', { hasText: new RegExp(`^${name}$`) }) });
const SECRET = 'sk-e2e-clave-secreta-123';

test.describe('Ajustes · proveedores', () => {
  test('proveedor compatible con OpenAI: alta con API key, modelos antes de guardar, edición, quitar clave y borrado', async ({ page, app }) => {
    app.fake.requiredApiKey = SECRET;
    const name = unique('Remoto');
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Añadir proveedor' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Añadir proveedor' });

    // Una plantilla rellena tipo, URL y nombre.
    await modal.getByRole('button', { name: 'LM Studio' }).click();
    await expect(modal.getByLabel('Tipo')).toHaveValue('openai');
    await expect(modal.getByLabel('URL base')).toHaveValue('http://localhost:1234/v1');
    await expect(modal.getByLabel('Nombre')).toHaveValue('LM Studio');

    await modal.getByLabel('Nombre').fill(name);
    await modal.getByLabel('URL base').fill(`${app.fake.url}/v1`);

    // Sin clave, la prueba falla con el mensaje del proveedor.
    await modal.getByRole('button', { name: 'Probar' }).click();
    await expect(modal.getByRole('alert')).toContainText('Clave de API no válida');

    // Con la clave, la prueba funciona y la lista de modelos se carga sin haber guardado nada.
    await modal.getByLabel(/API key/).fill(SECRET);
    await modal.getByRole('button', { name: 'Probar' }).click();
    await expect(modal.getByRole('status')).toContainText('Conexión correcta: 2 modelos');
    await expect(modal.getByText('2 modelos disponibles: elige uno de la lista o escríbelo.')).toBeVisible();
    await expect(modal.locator('#prv-models option')).toHaveCount(2);
    expect(await modal.locator('#prv-models option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value))).toEqual(['e2e-model', 'e2e-sin-herramientas']);
    expect((await app.api<any[]>('GET', '/api/providers')).some((p) => p.name === name)).toBe(false);
    await modal.getByLabel(/Modelo/).fill('e2e-model');

    // Cambiar la URL invalida la prueba y la lista de modelos.
    await modal.getByLabel('URL base').fill(`${app.fake.url}/v1/`);
    await expect(modal.locator('#prv-models option')).toHaveCount(0);
    await modal.getByLabel('URL base').fill(`${app.fake.url}/v1`);

    await modal.getByRole('button', { name: 'Añadir proveedor' }).click();
    await expect(toast(page, `Proveedor «${name}» añadido.`)).toBeVisible();
    const row = providerRow(page, name);
    await expect(row.getByText('Compatible con OpenAI')).toBeVisible();
    await expect(row.getByText('Clave guardada')).toBeVisible();
    await expect(row.getByRole('status')).toContainText('Disponible · 2 modelos');
    await expect(row.locator('code')).toHaveText('e2e-model');

    // La clave no vuelve nunca al navegador: ni en la API ni en la página.
    const listed = await page.evaluate(() => fetch('/api/providers').then((r) => r.text()));
    expect(listed).not.toContain(SECRET);
    expect(await page.content()).not.toContain(SECRET);
    const provider = (await app.api<any[]>('GET', '/api/providers')).find((p) => p.name === name);
    expect(provider).toMatchObject({ hasApiKey: true, kind: 'openai', defaultModel: 'e2e-model' });

    // «Probar conexión» usa la clave guardada.
    await row.getByRole('button', { name: 'Probar conexión' }).click();
    await expect(toast(page, `«${name}» responde: 2 modelos`)).toBeVisible();
    expect(app.fake.modelListAuth.at(-1)).toBe(`Bearer ${SECRET}`);

    // Un agente trabaja con él por el protocolo de OpenAI, autenticado con esa clave.
    const agent = await app.api('POST', '/api/agents', { name: unique('Vía OpenAI'), providerId: provider.id, model: 'e2e-model', tools: ['calculator'] });
    const run = await app.runToEnd('agents', agent.id, '[[herramienta:calculator {"expression":"6*7"}]] calcula');
    expect(run.status).toBe('completed');
    expect(run.output).toContain('"result": 42');
    const chat = app.fake.chats.at(-1)!;
    expect(chat).toMatchObject({ protocol: 'openai', authorization: `Bearer ${SECRET}` });

    // Editar sin tocar la clave: el campo aparece vacío y la clave NO se reenvía (ni vacía ni de ninguna forma).
    await row.getByRole('button', { name: `Editar ${name}` }).click();
    const edit = page.getByRole('dialog', { name: 'Editar proveedor' });
    await expect(edit.getByLabel(/API key/)).toHaveValue('');
    await expect(edit.getByLabel(/API key/)).toHaveAttribute('placeholder', /guardada/);
    const renamed = `${name} v2`;
    await edit.getByLabel('Nombre').fill(renamed);
    // «Probar» dentro del modal usa la clave guardada.
    await edit.getByRole('button', { name: 'Probar' }).click();
    await expect(edit.getByRole('status')).toContainText('Conexión correcta');
    await expect(edit.locator('#prv-models option')).toHaveCount(2);
    const [update] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/api/providers/${provider.id}`)),
      edit.getByRole('button', { name: 'Guardar cambios' }).click(),
    ]);
    expect(update.postDataJSON()).not.toHaveProperty('apiKey');
    await expect(toast(page, `Proveedor «${renamed}» actualizado.`)).toBeVisible();
    const renamedRow = providerRow(page, renamed);
    await expect(renamedRow.getByText('Clave guardada')).toBeVisible();
    await renamedRow.getByRole('button', { name: 'Probar conexión' }).click();
    await expect(toast(page, `«${renamed}» responde`)).toBeVisible();
    expect(app.fake.modelListAuth.at(-1)).toBe(`Bearer ${SECRET}`);

    // Cambiar la clave por una incorrecta se nota de inmediato en la prueba.
    await renamedRow.getByRole('button', { name: `Editar ${renamed}` }).click();
    await edit.getByLabel(/API key/).fill('sk-incorrecta');
    await expect(edit.getByRole('button', { name: 'Quitar clave' })).toHaveCount(0);
    await edit.getByRole('button', { name: 'Probar' }).click();
    await expect(edit.getByRole('alert')).toContainText('Clave de API no válida');
    await edit.getByLabel(/API key/).fill('');

    // «Quitar clave»: se puede deshacer; al guardar se envía apiKey: null y la clave desaparece.
    await edit.getByRole('button', { name: 'Quitar clave' }).click();
    await expect(edit.getByText('La clave guardada se eliminará al guardar.')).toBeVisible();
    await edit.getByRole('button', { name: 'Deshacer' }).click();
    await expect(edit.getByRole('button', { name: 'Quitar clave' })).toBeVisible();
    await edit.getByRole('button', { name: 'Quitar clave' }).click();
    const [removal] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/api/providers/${provider.id}`)),
      edit.getByRole('button', { name: 'Guardar cambios' }).click(),
    ]);
    expect(removal.postDataJSON().apiKey).toBeNull();
    await expect(renamedRow.getByText('Clave guardada')).toHaveCount(0);
    expect((await app.api<any[]>('GET', '/api/providers')).find((p) => p.id === provider.id).hasApiKey).toBe(false);
    // Sin clave, el proveedor (que la exige) deja de estar disponible y se explica por qué.
    await expect(renamedRow.getByRole('status')).toContainText('No disponible');
    await expect(renamedRow.locator('.p-error')).toContainText('Clave de API no válida');
    expect(app.fake.modelListAuth.at(-1)).toBeUndefined();

    // Borrado: bloqueado mientras lo use un agente.
    await renamedRow.getByRole('button', { name: `Eliminar ${renamed}` }).click();
    await page.getByRole('dialog', { name: 'Eliminar proveedor' }).getByRole('button', { name: 'Eliminar' }).click();
    await expect(toast(page, 'No se puede eliminar: 1 agente(s) usan este proveedor.')).toBeVisible();
    await expect(renamedRow).toHaveCount(1);
    await app.api('DELETE', `/api/agents/${agent.id}`);
    await renamedRow.getByRole('button', { name: `Eliminar ${renamed}` }).click();
    await page.getByRole('dialog', { name: 'Eliminar proveedor' }).getByRole('button', { name: 'Eliminar' }).click();
    await expect(toast(page, `Proveedor «${renamed}» eliminado.`)).toBeVisible();
    await expect(renamedRow).toHaveCount(0);
    expect((await app.api<any[]>('GET', '/api/providers')).some((p) => p.id === provider.id)).toBe(false);
  });

  test('el formulario de proveedor muestra los errores de validación del servidor en su campo', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Añadir proveedor' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Añadir proveedor' });
    await modal.getByLabel('Nombre').fill('Con URL rota');
    await modal.getByLabel('URL base').fill('esto no es una url');
    await modal.getByRole('button', { name: 'Añadir proveedor' }).click();
    await expect(modal.getByText('Debe ser una URL http(s) válida')).toBeVisible();
    await expect(modal.getByLabel('URL base')).toHaveAttribute('aria-invalid', 'true');
    // Un proveedor inalcanzable se diagnostica al probar, sin guardar.
    await modal.getByLabel('URL base').fill('http://127.0.0.1:9');
    await modal.getByRole('button', { name: 'Probar' }).click();
    await expect(modal.getByRole('alert')).toContainText('No se pudo conectar');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('desactivar un proveedor impide ejecutar sus agentes; reactivarlo lo restablece', async ({ page, app }) => {
    const name = unique('Conmutable');
    const provider = await app.api('POST', '/api/providers', { name, kind: 'ollama', baseUrl: app.fake.url, defaultModel: 'e2e-model' });
    const agent = await app.api('POST', '/api/agents', { name: unique('Dependiente'), providerId: provider.id, model: 'e2e-model' });
    await page.goto('/settings');
    const row = providerRow(page, name);
    await expect(row.getByRole('status')).toContainText('Disponible');
    await expect(row).toContainText('1 agente lo usa');

    await row.getByLabel(`Desactivar ${name}`).uncheck();
    await expect(toast(page, `«${name}» desactivado.`)).toBeVisible();
    await expect(row.getByRole('status')).toContainText('Desactivado');
    await expect(row.getByRole('button', { name: 'Probar conexión' })).toBeDisabled();
    const blocked = await app.runToEnd('agents', agent.id, 'hola');
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toContain('está desactivado');

    await row.getByLabel(`Activar ${name}`).check();
    await expect(toast(page, `«${name}» activado.`)).toBeVisible();
    await expect(row.getByRole('status')).toContainText('Disponible');
    expect((await app.runToEnd('agents', agent.id, 'hola')).status).toBe('completed');
  });
});

test.describe('Ajustes · ejecución, seguridad y datos', () => {
  test('ejecuciones simultáneas máximas: el límite se aplica de verdad y el resto espera en cola', async ({ page, app }) => {
    await page.goto('/settings');
    const input = page.getByLabel('Ejecuciones simultáneas máximas');
    await expect(input).toHaveValue('3');

    // Un valor fuera de rango se rechaza y se restaura el anterior.
    await input.fill('0');
    await input.blur();
    await expect(toast(page, 'debe estar entre 1 y 10')).toBeVisible();
    await expect(input).toHaveValue('3');

    await input.fill('1');
    await input.blur();
    await expect(toast(page, 'Ejecuciones simultáneas: 1.')).toBeVisible();
    expect((await app.api('GET', '/api/settings')).maxConcurrentRuns).toBe(1);

    const agent = await app.createAgent({ name: unique('Cola'), systemPrompt: '[[lento]]' });
    const first = await app.api('POST', `/api/agents/${agent.id}/run`, { input: 'primera' });
    const second = await app.api('POST', `/api/agents/${agent.id}/run`, { input: 'segunda' });
    await expect.poll(async () => (await app.api('GET', `/api/runs/${first.id}`)).status).toBe('running');
    // La segunda no arranca mientras la primera siga en marcha.
    await page.waitForTimeout(600);
    expect((await app.api('GET', `/api/runs/${second.id}`)).status).toBe('queued');
    expect(app.fake.chats.filter((c) => c.user === 'segunda')).toHaveLength(0);

    await page.goto(`/runs/${second.id}`);
    await expect(page.locator('.page-header .badge').first()).toHaveText('En cola');
    await expect(page.getByText('En cola, esperando turno…')).toBeVisible();

    // Al terminar la primera, la segunda toma su turno sola.
    await app.api('POST', `/api/runs/${first.id}/cancel`);
    await expect(page.locator('.page-header .badge').first()).toHaveText('En curso');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.locator('.page-header .badge').first()).toHaveText('Cancelado');

    // El ajuste se conserva al recargar.
    await page.goto('/settings');
    await expect(page.getByLabel('Ejecuciones simultáneas máximas')).toHaveValue('1');
  });

  test('permitir ejecución de código: pide confirmación y habilita run_javascript de verdad', async ({ page, app }) => {
    await page.goto('/tools');
    await expect(page.getByText('La ejecución de código está desactivada')).toBeVisible();
    await page.getByRole('button', { name: 'Probar Ejecutar JavaScript' }).click();
    let bench = page.getByRole('dialog', { name: 'Probar Ejecutar JavaScript' });
    await bench.getByLabel('code').fill('[1, 2, 3].map((x) => x * 2)');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.locator('.codeblock')).toContainText('La ejecución de código está desactivada');
    await bench.getByRole('button', { name: 'Cerrar' }).first().click();

    await page.getByRole('link', { name: 'Ajustes', exact: true }).first().click();
    const toggle = page.getByLabel('Permitir ejecución de código');
    // Cancelar la confirmación deja el interruptor como estaba.
    await toggle.check();
    await page.getByRole('dialog', { name: 'Permitir ejecución de código' }).getByRole('button', { name: 'Cancelar' }).click();
    await expect(toggle).not.toBeChecked();
    expect((await app.api('GET', '/api/settings')).allowCodeExecution).toBe(false);

    await toggle.check();
    await page.getByRole('dialog', { name: 'Permitir ejecución de código' }).getByRole('button', { name: 'Permitir' }).click();
    await expect(toast(page, 'Ejecución de código permitida.')).toBeVisible();
    await expect(toggle).toBeChecked();
    // Al activarla aparece dónde se ejecuta el código, con el estado que comprueba el servidor.
    const options = page.getByTestId('sandbox-options');
    await expect(options.getByRole('radio', { name: /Proceso aislado/ })).toBeChecked();
    await expect(options.getByText('Sin red (comprobado con una conexión real al arrancar).')).toBeVisible();
    await expect(options.getByText('no es una barrera del sistema operativo')).toBeVisible();
    // El contenedor solo se puede elegir si hay Docker o Podman en marcha con la imagen descargada.
    const status = await app.api('GET', '/api/sandbox/status');
    expect(status.process.networkBlocked).toBe(true);
    const container = options.getByRole('radio', { name: /Contenedor/ });
    if (status.container.available) await expect(container).toBeEnabled();
    else {
      await expect(container).toBeDisabled();
      await expect(options.getByText('No disponible:')).toBeVisible();
    }

    await page.getByRole('link', { name: 'Herramientas' }).click();
    await expect(page.getByText('La ejecución de código está desactivada')).toHaveCount(0);
    await page.getByRole('button', { name: 'Probar Ejecutar JavaScript' }).click();
    bench = page.getByRole('dialog', { name: 'Probar Ejecutar JavaScript' });
    await bench.getByLabel('code').fill('[1, 2, 3].map((x) => x * 2)');
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('Ejecutada correctamente')).toBeVisible();
    await expect(bench.locator('.codeblock')).toContainText(/2,\s*4,\s*6/);
    // El aislamiento no da acceso a los módulos de Node.
    await bench.getByLabel('code').fill("require('node:fs').readdirSync('.')");
    await bench.getByRole('button', { name: 'Ejecutar' }).click();
    await expect(bench.getByText('La herramienta devolvió un error')).toBeVisible();
    await bench.getByRole('button', { name: 'Cerrar' }).first().click();

    // Desactivar no pide confirmación y vuelve a bloquear la herramienta.
    await page.getByRole('link', { name: 'Ajustes', exact: true }).first().click();
    await page.getByLabel('Permitir ejecución de código').uncheck();
    await expect(toast(page, 'Ejecución de código desactivada.')).toBeVisible();
    const res = await app.api('POST', '/api/tools/run_javascript/invoke', { args: { code: '1+1' } });
    expect(res.ok).toBe(false);
  });

  test('permitir redes privadas: desactivarlo vuelve a bloquear las llamadas a localhost', async ({ page, app }) => {
    // Un servicio de la red local (aquí, el modelo simulado, que escucha en 127.0.0.1).
    const call = () => app.api('POST', '/api/tools/http_request/invoke', { args: { url: `${app.fake.url}/api/tags` } });
    // La propia API de AgentForge: inalcanzable para las herramientas con cualquier ajuste.
    const callSelf = () => app.api('POST', '/api/tools/http_request/invoke', { args: { url: `${app.url}/api/settings` } });
    await page.goto('/settings');
    const toggle = page.getByLabel('Permitir redes privadas');
    await expect(toggle).not.toBeChecked();
    expect((await call()).ok).toBe(false);

    await toggle.check();
    await page.getByRole('dialog', { name: 'Permitir redes privadas' }).getByRole('button', { name: 'Permitir' }).click();
    await expect(toast(page, 'Acceso a redes privadas permitido.')).toBeVisible();
    expect((await call()).ok).toBe(true);
    const self = await callSelf();
    expect(self.ok).toBe(false);
    expect(self.error).toContain('propia API de AgentForge');
    // El aviso del catálogo de herramientas desaparece.
    await page.getByRole('link', { name: 'Herramientas' }).click();
    await expect(page.getByText('no pueden acceder a tu')).toHaveCount(0);

    await page.getByRole('link', { name: 'Ajustes', exact: true }).first().click();
    await page.getByLabel('Permitir redes privadas').uncheck();
    await expect(toast(page, 'Acceso a redes privadas bloqueado.')).toBeVisible();
    expect((await call()).ok).toBe(false);
    await page.getByRole('link', { name: 'Herramientas' }).click();
    await expect(page.getByText('no pueden acceder a tu')).toBeVisible();
  });

  test('eliminar ejecuciones terminadas borra el historial sin tocar las que están en curso', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Historial') });
    await app.runToEnd('agents', agent.id, '[[decir:uno]]');
    await app.runToEnd('agents', agent.id, '[[decir:dos]]');
    const running = await app.api('POST', `/api/agents/${agent.id}/run`, { input: '[[lento]] sigue' });
    await expect.poll(async () => (await app.api('GET', `/api/runs/${running.id}`)).status).toBe('running');
    const finishedBefore = (await app.api('GET', '/api/runs?limit=200')).items.filter((r: any) => !['queued', 'running'].includes(r.status)).length;
    expect(finishedBefore).toBeGreaterThanOrEqual(2);

    await page.goto('/settings');
    const data = page.locator('section[aria-labelledby="sec-data"]');
    await expect(data.locator('.facts div').filter({ hasText: 'Terminadas' }).locator('dd')).toHaveText(String(finishedBefore));
    await data.getByRole('button', { name: 'Eliminar ejecuciones terminadas' }).click();
    const confirm = page.getByRole('dialog', { name: 'Eliminar ejecuciones terminadas' });
    await expect(confirm).toContainText(`${finishedBefore} ejecuciones terminadas`);
    await confirm.getByRole('button', { name: 'Eliminar' }).click();
    await expect(toast(page, `${finishedBefore} ejecuciones eliminadas.`)).toBeVisible();

    // Las cifras se actualizan y el botón queda desactivado: ya no hay nada que borrar.
    await expect(data.locator('.facts div').filter({ hasText: 'Terminadas' }).locator('dd')).toHaveText('0');
    await expect(data.getByRole('button', { name: 'Eliminar ejecuciones terminadas' })).toBeDisabled();
    const after = (await app.api('GET', '/api/runs?limit=200')).items;
    expect(after.map((r: any) => r.id)).toEqual([running.id]);
    expect(after[0].status).toBe('running');

    // Los agentes y workflows no se tocan.
    expect((await app.api<any[]>('GET', '/api/agents')).some((a) => a.id === agent.id)).toBe(true);
    await app.api('POST', `/api/runs/${running.id}/cancel`);
    await app.waitForRun(running.id);
  });

  test('retención del historial: el límite configurado borra las ejecuciones antiguas y se conserva', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Retención') });
    for (const text of ['uno', 'dos', 'tres']) await app.runToEnd('agents', agent.id, `[[decir:${text}]]`);
    const finished = async () => (await app.api('GET', '/api/runs?limit=200')).items.filter((r: any) => !['queued', 'running'].includes(r.status));
    expect((await finished()).length).toBeGreaterThanOrEqual(3);

    await page.goto('/settings');
    const data = page.locator('section[aria-labelledby="sec-data"]');
    const maxRuns = page.getByLabel('Máximo de ejecuciones guardadas');
    const days = page.getByLabel('Conservar el historial (días)');
    await expect(maxRuns).toHaveValue('0');
    await expect(days).toHaveValue('0');

    // Valores no válidos: se avisa y se restaura el anterior.
    await maxRuns.fill('-5');
    await maxRuns.blur();
    await expect(toast(page, '0 = sin límite')).toBeVisible();
    await expect(maxRuns).toHaveValue('0');

    // Con un máximo de 2 solo sobreviven las dos más recientes, y las cifras se actualizan.
    await maxRuns.fill('2');
    await maxRuns.blur();
    await expect(toast(page, 'Se conservarán como máximo 2 ejecuciones terminadas.')).toBeVisible();
    const kept = await finished();
    expect(kept.map((r: any) => r.output).sort()).toEqual(['dos', 'tres']);
    await expect(data.locator('.facts div').filter({ hasText: 'Ejecuciones guardadas' }).locator('dd')).toHaveText('2');

    // El límite se sigue aplicando solo, al terminar cada ejecución nueva.
    await app.runToEnd('agents', agent.id, '[[decir:cuatro]]');
    expect((await finished()).map((r: any) => r.output).sort()).toEqual(['cuatro', 'tres']);

    await days.fill('30');
    await days.blur();
    await expect(toast(page, 'Las ejecuciones terminadas se conservarán 30 días.')).toBeVisible();
    expect(await app.api('GET', '/api/settings')).toMatchObject({ retentionDays: 30, retentionMaxRuns: 2 });
    expect((await finished()).length).toBe(2); // nada tiene más de 30 días

    await page.reload();
    await expect(page.getByLabel('Máximo de ejecuciones guardadas')).toHaveValue('2');
    await expect(page.getByLabel('Conservar el historial (días)')).toHaveValue('30');
    await page.getByLabel('Conservar el historial (días)').fill('0');
    await page.getByLabel('Conservar el historial (días)').blur();
    await expect(toast(page, 'El historial ya no caduca por antigüedad.')).toBeVisible();
  });

  test('la sección Sistema muestra datos reales del servidor', async ({ page, app }) => {
    await page.goto('/settings');
    const system = page.locator('section[aria-labelledby="sec-system"]');
    await expect(system).toContainText(process.version);
    const data = page.locator('section[aria-labelledby="sec-data"]');
    await expect(data.locator('.path')).toHaveText(app.dataDir);
  });
});
