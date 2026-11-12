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

/**
 * Texto de interfaz en español dentro de una pantalla en inglés. Criterio (pensado para no ser frágil): el español
 * se delata por las letras que el inglés no usa (vocales con tilde, «ñ», «¿», «¡»). Se mira el texto PROPIO de cada
 * elemento (menú, cabeceras, botones, etiquetas, avisos…) y los atributos `aria-label`, `title` y `placeholder`,
 * salvo lo que no es interfaz fija: el selector de idioma («Español»), las filas de datos (`tbody`), el código y los
 * campos y opciones que llevan datos del usuario o del servidor. Antes de comprobar, se quita del texto lo que el
 * servidor entrega ya escrito en español (títulos, descripciones y categorías de las herramientas integradas y las
 * descripciones de sus parámetros), que no se traduce todavía y no es un olvido de la interfaz.
 */
const SPANISH_LETTERS = /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/;

async function expectNoSpanishUi(page: Page, serverTexts: string[]): Promise<void> {
  const texts = await page.evaluate(() => {
    const NOT_UI = '.langs, tbody, pre, code, textarea, input, select, option, script, style, [data-testid="announcer"]';
    const found: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest(NOT_UI)) continue;
      for (const attribute of ['aria-label', 'title', 'placeholder']) {
        const value = el.getAttribute(attribute);
        if (value) found.push(value);
      }
      for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) found.push(child.textContent.trim());
    }
    return found;
  });
  const spanish = texts.map((text) => serverTexts.reduce((rest, data) => rest.split(data).join(' '), text)).filter((text) => SPANISH_LETTERS.test(text));
  expect(spanish, `Texto de interfaz en español en ${page.url()}`).toEqual([]);
}

/** Todo lo que revisa la prueba de inglés en cada pantalla. */
async function expectEnglishScreen(page: Page, serverTexts: string[]): Promise<void> {
  await expectNoRawKeys(page);
  await expectNoSpanishUi(page, serverTexts);
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

  test('todas las pantallas están en inglés: sin claves sin traducir ni texto de interfaz en español, y un workflow nuevo nace con «Input» y «Output»', async ({
    page,
    app,
  }) => {
    const agent = await app.createAgent({ name: unique('English'), systemPrompt: '[[decir:done]]' });
    const run = await app.runToEnd('agents', agent.id, 'hello');
    // Lo que el servidor entrega ya en español (herramientas integradas) no cuenta como un olvido de la interfaz.
    const tools = await app.api<
      Array<{ title: string; description: string; category: string; parameters?: { properties?: Record<string, { description?: string }> } }>
    >('GET', '/api/tools');
    // Tampoco los datos del usuario: nombres, roles y descripciones de agentes y workflows (los de ejemplo y los
    // que han creado otros tests en este mismo servidor están en español).
    const named = [
      ...(await app.api<Array<{ name: string; role?: string; description?: string }>>('GET', '/api/agents')),
      ...(await app.api<Array<{ name: string; description?: string }>>('GET', '/api/workflows')),
    ];
    const serverTexts: string[] = [
      ...tools.flatMap((tool) => [
        tool.title,
        tool.description,
        tool.category,
        ...Object.values(tool.parameters?.properties ?? {}).map((p) => p.description ?? ''),
      ]),
      ...named.flatMap((item): string[] => [item.name, (item as { role?: string }).role ?? '', item.description ?? '']),
    ]
      .filter((text) => text.length > 2)
      .sort((x, y) => y.length - x.length);
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
      await expectEnglishScreen(page, serverTexts);
    }

    // Ficha de un agente, monitor de una ejecución y constructor.
    await page.goto(`/agents/${agent.id}`);
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expectEnglishScreen(page, serverTexts);

    await page.goto(`/runs/${run.id}`);
    await expect(page.locator('.badge').filter({ hasText: 'Completed' }).first()).toBeVisible();
    await expectEnglishScreen(page, serverTexts);

    await page.goto('/workflows/new');
    await expect(page.locator('.vue-flow__node')).toHaveCount(2);
    // Los nodos con los que nace un workflow nuevo se rotulan en el idioma activo (los ids siguen siendo los mismos).
    await expect(page.locator('.vue-flow__node[data-id="entrada"]')).toContainText('Input');
    await expect(page.locator('.vue-flow__node[data-id="salida"]')).toContainText('Output');
    await expect(page.locator('.vue-flow__node[data-id="entrada"]')).not.toContainText('Entrada');
    await expect(page.locator('.vue-flow__node[data-id="salida"]')).not.toContainText('Salida');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
    await expectEnglishScreen(page, serverTexts);
    // La validación del workflow (que calcula el código compartido con el servidor) también sale en inglés.
    await page.locator('.check-badge').click();
    await expect(page.getByLabel('Properties').locator('.validation').first()).toContainText('needs an incoming connection');

    // El glosario: definiciones en inglés en la página y en el tooltip.
    await page.goto('/glosario');
    await expect(page.locator('main')).toContainText('A language model with a role');
    await expectEnglishScreen(page, serverTexts);
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
