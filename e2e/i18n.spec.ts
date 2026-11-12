// Inglés además de español (hito 5, fase 7): selector de idioma, idioma del navegador, formatos y errores.
import type { Page } from '@playwright/test';
import { expect, test, unique } from './support/fixtures';

/** Una clave de traducción sin resolver se pintaría tal cual («runs.filters.all»). */
const RAW_KEY =
  /\b(app|common|runs|runDetail|runActivity|runGraph|runState|playground|interrupted|approvals|settings|providerModal|accessGate|tools|toolEditor|toolTest|mcp|builder|flowNode|flow|dashboard|guide|agents|agentEditor|usage|workflows|triggers|importModal|transfer|glossaryView|notFound|term)\.[a-z][A-Za-z]*(\.[A-Za-z]+)*\b/;

async function expectNoRawKeys(page: Page): Promise<void> {
  const text = await page.locator('body').innerText();
  const attributes = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label], [title], [placeholder]')]
      .flatMap((el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder')])
      .filter(Boolean)
      .join('\n'),
  );
  // Las rutas de archivo y los nombres de modelo tienen puntos, pero no empiezan por el nombre de un ámbito.
  expect(`${text}\n${attributes}`.match(RAW_KEY)?.[0] ?? null, `Clave sin traducir en ${page.url()}`).toBeNull();
}

const switchTo = (page: Page, label: 'English' | 'Español') => page.locator('.langs').getByRole('button', { name: label }).click();

test.describe('Idiomas', () => {
  test('el selector cambia toda la interfaz a inglés sin recargar, se recuerda y se puede volver al español', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Panel', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    const nav = page.locator('.sidebar nav');
    await expect(nav.getByRole('link', { name: 'Ejecuciones' })).toBeVisible();

    await switchTo(page, 'English');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle('Dashboard · AgentForge');
    await expect(nav.getByRole('link', { name: 'Runs' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
    await expect(page.locator('.langs').getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');

    // Se recuerda al recargar y al navegar.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await nav.getByRole('link', { name: 'Agents' }).click();
    await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle('Agents · AgentForge');
    await expect(page.getByTestId('announcer')).toHaveText('Page: Agents');

    await switchTo(page, 'Español');
    await expect(page.getByRole('heading', { name: 'Agentes', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page).toHaveTitle('Agentes · AgentForge');
  });

  test('todas las pantallas están en inglés y ninguna enseña una clave sin traducir', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('English'), systemPrompt: '[[decir:done]]' });
    const run = await app.runToEnd('agents', agent.id, 'hello');
    await page.goto('/');
    await switchTo(page, 'English');

    const screens: Array<[path: string, heading: string]> = [
      ['/', 'Dashboard'],
      ['/agents', 'Agents'],
      ['/workflows', 'Workflows'],
      ['/runs', 'Runs'],
      ['/tools', 'Tools'],
      ['/settings', 'Settings'],
      ['/glosario', 'Glossary'],
    ];
    for (const [path, heading] of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expectNoRawKeys(page);
    }

    // Ficha de un agente, monitor de una ejecución y constructor.
    await page.goto(`/agents/${agent.id}`);
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expectNoRawKeys(page);

    await page.goto(`/runs/${run.id}`);
    await expect(page.locator('.badge').filter({ hasText: 'Completed' }).first()).toBeVisible();
    await expectNoRawKeys(page);

    await page.goto('/workflows/new');
    await expect(page.locator('.vue-flow__node')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
    await expectNoRawKeys(page);
    // La validación del workflow (que calcula el código compartido con el servidor) también sale en inglés.
    await page.locator('.check-badge').click();
    await expect(page.getByLabel('Properties').locator('.validation').first()).toContainText('needs an incoming connection');

    // El glosario: definiciones en inglés en la página y en el tooltip.
    await page.goto('/glosario');
    await expect(page.locator('main')).toContainText('A language model with a role');
    await expectNoRawKeys(page);
  });

  test('en español tampoco queda ninguna clave sin traducir', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Claves') });
    for (const path of ['/', '/agents', `/agents/${agent.id}`, '/workflows', '/workflows/new', '/runs', '/tools', '/settings', '/glosario']) {
      await page.goto(path);
      await expect(page.locator('main h1, main .name').first()).toBeAttached();
      await expectNoRawKeys(page);
    }
  });

  test('números, fechas y errores del servidor siguen al idioma', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Formato'), systemPrompt: '[[decir:ok]]' });
    await app.runToEnd('agents', agent.id, 'uno');
    await page.goto('/runs');
    await expect(page.locator('tbody tr').first()).toContainText(/ahora mismo|hace \d+/);
    await switchTo(page, 'English');
    await expect(page.locator('tbody tr').first()).toContainText(/just now|\d+ (second|minute)s? ago/);
    await expect(page.getByRole('button', { name: 'Completed' })).toBeVisible();

    // Un error genérico del servidor (404) se muestra en el idioma de la interfaz.
    await page.goto('/runs/run_que_no_existe');
    await expect(page.getByRole('heading', { name: 'The run could not be loaded' })).toBeVisible();
    await expect(page.locator('main')).toContainText('was not found');
    await switchTo(page, 'Español');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'No se pudo cargar la ejecución' })).toBeVisible();
    await expect(page.locator('main')).toContainText('no encontrada');
  });

  test('un navegador en inglés arranca en inglés; uno en español, en español', async ({ browser, app }) => {
    const english = await browser.newContext({ locale: 'en-GB' });
    const spanish = await browser.newContext({ locale: 'es-MX' });
    try {
      const a = await english.newPage();
      await a.goto(`${app.url}/agents`);
      await expect(a.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
      await expect(a.locator('html')).toHaveAttribute('lang', 'en');

      const b = await spanish.newPage();
      await b.goto(`${app.url}/agents`);
      await expect(b.getByRole('heading', { name: 'Agentes', level: 1 })).toBeVisible();
      await expect(b.locator('html')).toHaveAttribute('lang', 'es');
    } finally {
      await english.close();
      await spanish.close();
    }
  });
});
