import fs from 'node:fs';
import { expect, test, toast, unique } from './support/fixtures';

test.describe('Ajustes · copias de seguridad', () => {
  test('crear una copia, descargarla, restaurarla tras reiniciar, añadir una desde archivo y borrarlas', async ({ page, app }) => {
    const before = await app.createAgent({ name: unique('Antes de la copia') });
    await page.goto('/settings');
    const section = page.getByRole('region', { name: 'Copias de seguridad' });
    const copies = section.getByRole('list', { name: 'Copias de seguridad guardadas' }).getByRole('listitem');
    const existing = await copies.count();

    // Crear.
    await section.getByRole('button', { name: 'Crear copia' }).click();
    await expect(toast(page, /Copia de seguridad creada \(.+\)\./)).toBeVisible();
    await expect(copies).toHaveCount(existing + 1);
    const copy = copies.first();
    await expect(copy).toContainText(/\d+ agentes?, \d+ workflows?, \d+ ejecuci(ón|ones), \d+ archivos?/);

    // Descargar: el archivo llega entero y con su nombre.
    const [download] = await Promise.all([page.waitForEvent('download'), copy.getByRole('link', { name: 'Descargar' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^agentforge-\d{8}-\d{6}\.afbackup$/);
    const file = await download.path();
    const state = await app.api('GET', '/api/backups');
    expect(fs.statSync(file).size).toBe(state.backups[0].sizeBytes);

    // Después de la copia se crea otro agente: la restauración debe hacerlo desaparecer.
    const after = await app.createAgent({ name: unique('Después de la copia') });

    // Restaurar pide confirmación y, hasta reiniciar, no cambia nada.
    await copy.getByRole('button', { name: 'Restaurar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restaurar esta copia' });
    await expect(dialog).toContainText('Los datos actuales no se borran');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    expect((await app.api('GET', '/api/backups')).pending).toBeNull();

    await copy.getByRole('button', { name: 'Restaurar' }).click();
    await page.getByRole('dialog', { name: 'Restaurar esta copia' }).getByRole('button', { name: 'Preparar restauración' }).click();
    await expect(toast(page, 'Restauración preparada. Reinicia AgentForge para aplicarla.')).toBeVisible();
    await expect(section.getByText('Restauración preparada.')).toBeVisible();
    expect((await app.api('GET', '/api/agents')).map((a: { id: string }) => a.id)).toContain(after.id);

    // Cancelarla deja todo como estaba; se vuelve a preparar para aplicarla de verdad.
    await section.getByRole('button', { name: 'Cancelar restauración' }).click();
    await expect(toast(page, 'Restauración cancelada. Los datos actuales se conservan.')).toBeVisible();
    await expect(section.getByText('Restauración preparada.')).toHaveCount(0);
    await copy.getByRole('button', { name: 'Restaurar' }).click();
    await page.getByRole('dialog', { name: 'Restaurar esta copia' }).getByRole('button', { name: 'Preparar restauración' }).click();
    await expect(section.getByText('Restauración preparada.')).toBeVisible();

    // Reinicio ordenado del servidor: al volver, los datos son los de la copia.
    expect(await app.shutdown()).toBe(0);
    await app.start();
    const agents = (await app.api('GET', '/api/agents')).map((a: { id: string }) => a.id);
    expect(agents).toContain(before.id);
    expect(agents).not.toContain(after.id);

    await page.goto('/settings');
    await expect(section.getByText(/Se restauró la copia del .+ Los datos que había antes están en/)).toBeVisible();
    await expect(section.getByText('Restauración preparada.')).toHaveCount(0);
    await page.goto('/agents');
    await expect(page.getByRole('link', { name: before.name })).toBeVisible();
    await expect(page.getByRole('link', { name: after.name })).toHaveCount(0);

    // Añadir una copia desde un archivo (la que se descargó antes).
    await page.goto('/settings');
    // Las copias no forman parte de lo que se restaura: la lista sigue teniendo las de antes.
    const total = existing + 1;
    await expect(copies).toHaveCount(total);
    await section.getByLabel('Archivo de copia de seguridad').setInputFiles({ name: 'mi-copia.afbackup', mimeType: 'application/octet-stream', buffer: fs.readFileSync(file) });
    await expect(toast(page, 'Copia de seguridad añadida. Ya puedes restaurarla.')).toBeVisible();
    await expect(copies).toHaveCount(total + 1);
    await expect(copies.filter({ hasText: 'añadida' })).toHaveCount(1);

    // Un archivo que no es una copia se rechaza con un mensaje y no se guarda.
    await section.getByLabel('Archivo de copia de seguridad').setInputFiles({ name: 'falsa.afbackup', mimeType: 'application/octet-stream', buffer: Buffer.from('no soy una copia') });
    await expect(toast(page, /no es una copia de seguridad|está dañado/)).toBeVisible();
    await expect(copies).toHaveCount(total + 1);

    // Borrar pide confirmación.
    for (let left = total + 1; left > 0; left--) {
      await copies.first().getByRole('button', { name: /^Eliminar la copia del / }).click();
      await page.getByRole('dialog', { name: 'Eliminar copia de seguridad' }).getByRole('button', { name: 'Eliminar copia' }).click();
      await expect(copies).toHaveCount(left - 1);
    }
    await expect(section.getByText('Todavía no hay ninguna copia de seguridad.')).toBeVisible();
    expect((await app.api('GET', '/api/backups')).backups).toEqual([]);
  });
});
