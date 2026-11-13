// Recorrido guiado: no se abre solo en un navegador automatizado, y se recorre entero (bienvenida → Panel → Agentes →
// constructor del workflow de bienvenida → ejecución real con el modelo simulado → aprobación → resultado → cierre)
// en las dos pieles.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';

const card = (page: Page) => page.locator('.tour-card');

/** Pulsa «Siguiente» hasta llegar al paso indicado (los nodos que el workflow no tiene se saltan solos). */
async function nextUntil(page: Page, stepId: string, max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    if ((await card(page).getAttribute('data-step')) === stepId) return;
    const before = await card(page).getAttribute('data-step');
    await card(page).getByRole('button', { name: 'Siguiente' }).click();
    await expect(card(page)).not.toHaveAttribute('data-step', before ?? '');
  }
  await expect(card(page)).toHaveAttribute('data-step', stepId);
}

const step = (page: Page): Locator => card(page);

test.describe('Recorrido guiado', () => {
  test('en una sesión automatizada no se ofrece ni se abre solo', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Panel', level: 1 })).toBeVisible();
    await expect(page.getByTestId('tour-offer')).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId('tour-launcher')).toBeVisible();
  });

  for (const skin of ['Normal', 'Modo Yōkai'] as const) {
    test(`se recorre de principio a fin con una ejecución real (${skin})`, async ({ page }) => {
      const yokai = skin === 'Modo Yōkai';
      await page.goto('/');
      await page.getByTestId('tour-launcher').click();
      await expect(step(page)).toHaveAttribute('data-step', 'welcome');
      await expect(page.getByRole('dialog', { name: /Bienvenid/ })).toBeVisible();

      // Bienvenida: se elige la presentación (cambia al momento).
      await step(page)
        .getByRole('button', { name: new RegExp(skin) })
        .click();
      if (yokai) await expect(page.locator('html')).toHaveAttribute('data-skin', 'yokai');
      else await expect(page.locator('html')).not.toHaveAttribute('data-skin', 'yokai');
      if (yokai) await expect(step(page).locator('.narrator')).toBeVisible();

      // Panel y Agentes: la app navega sola con «Siguiente».
      await nextUntil(page, 'dashboard');
      await expect(page).toHaveURL(/\/$/);
      await nextUntil(page, 'agents');
      await expect(page).toHaveURL(/\/agents$/);

      // Constructor: se prepara (o reutiliza) el workflow de bienvenida y se explican sus nodos.
      await nextUntil(page, 'builder');
      await expect(page).toHaveURL(/\/workflows\/[^/]+$/);
      await expect(page.locator('.vue-flow__node').first()).toBeVisible();
      await nextUntil(page, 'node-agent');
      await expect(page.getByTestId('onboarding-halo')).toBeVisible();
      await nextUntil(page, 'launch');
      await expect(step(page).getByRole('button', { name: 'Siguiente' })).toHaveCount(0);

      // El usuario lanza la ejecución de verdad; el recorrido avanza solo.
      await page.locator('[data-tour="run-button"]').click();
      const dialog = page.getByRole('dialog', { name: 'Ejecutar workflow' });
      await dialog.getByRole('textbox').fill('Hola desde el recorrido');
      await dialog.getByRole('button', { name: 'Ejecutar' }).click();
      await expect(page).toHaveURL(/\/runs\/run_/);
      await expect(step(page)).toHaveAttribute('data-step', 'run-live');
      if (yokai) {
        await expect(page.locator('.yokai-floor')).toBeVisible();
        await nextUntil(page, 'run-switch');
      }
      await nextUntil(page, 'run-steps');
      await step(page).getByRole('button', { name: 'Siguiente' }).click();

      // Aprobación: se decide desde el aviso y el recorrido sigue solo hasta el resultado.
      await expect(step(page)).toHaveAttribute('data-step', /approval|result/);
      if ((await step(page).getAttribute('data-step')) === 'approval') {
        const banner = page.getByRole('region', { name: /espera tu decisión/ });
        await banner
          .locator('li')
          .filter({ hasText: /Bienvenida/ })
          .first()
          .getByRole('button', { name: 'Aprobar' })
          .click();
      }
      await expect(step(page)).toHaveAttribute('data-step', 'result');
      await expect(page.locator('.page-header .badge').first()).toHaveText(/Completado|Fallido/, { timeout: 20_000 });
      await expect(step(page).locator('.note.waiting')).toHaveCount(0);

      // Cierre con enlaces a lo siguiente; al terminar queda guardado como completado.
      await nextUntil(page, 'finish');
      await expect(step(page).getByRole('link', { name: /agente/ })).toBeVisible();
      await step(page).getByRole('button', { name: 'Terminar' }).click();
      await expect(card(page)).toHaveCount(0);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('af-onboarding') ?? '{}'));
      expect(saved.status).toBe('completed');
    });
  }

  test('Esc cierra la tarjeta y el lanzador la reanuda en el mismo paso', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tour-launcher').click();
    await card(page).getByRole('button', { name: 'Siguiente' }).click();
    await expect(card(page)).toHaveAttribute('data-step', 'dashboard');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId('tour-launcher')).toHaveAccessibleName('Reanudar el recorrido');
    await page.getByTestId('tour-launcher').click();
    await expect(card(page)).toHaveAttribute('data-step', 'dashboard');
    await card(page).getByRole('button', { name: 'Saltar recorrido' }).click();
    await expect(card(page)).toHaveCount(0);
  });
});
