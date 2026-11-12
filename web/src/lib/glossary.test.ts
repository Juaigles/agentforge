// Coherencia del glosario: cada <Term> apunta a una entrada que existe, cada entrada se usa en alguna pantalla
// y ningún término está dentro de un botón, un enlace, un bloque de código o un título.
import { parse } from '@vue/compiler-sfc';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { GLOSSARY, GLOSSARY_EN, glossaryEntries } from './glossary';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function vueFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return vueFiles(full);
    return entry.name.endsWith('.vue') ? [full] : [];
  });
}

interface TermUse {
  file: string;
  line: number;
  id: string | null;
  /** Etiquetas antecesoras, de fuera hacia dentro. */
  ancestors: string[];
}

/** Recorre el árbol de la plantilla (incluidas las ramas de v-if y los cuerpos de v-for). */
function collect(node: any, ancestors: string[], file: string, out: TermUse[]): void {
  if (!node || typeof node !== 'object') return;
  let chain = ancestors;
  if (node.type === 1 /* elemento */) {
    if (node.tag === 'Term') {
      const idProp = (node.props ?? []).find((p: any) => p.type === 6 && p.name === 'id');
      out.push({ file, line: node.loc.start.line, id: idProp?.value?.content ?? null, ancestors });
    }
    chain = [...ancestors, node.tag];
  }
  for (const child of node.children ?? []) collect(child, chain, file, out);
  for (const branch of node.branches ?? []) collect(branch, chain, file, out);
}

const uses: TermUse[] = [];
for (const file of vueFiles(srcDir)) {
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: file });
  if (descriptor.template?.ast) collect(descriptor.template.ast, [], path.relative(srcDir, file).replace(/\\/g, '/'), uses);
}
const where = (u: TermUse) => `${u.file}:${u.line}`;

describe('glosario', () => {
  it('se han encontrado los términos de las pantallas', () => {
    // Si el análisis de las plantillas dejara de funcionar, el resto de comprobaciones pasarían en falso.
    expect(uses.length).toBeGreaterThan(50);
    expect(new Set(uses.map((u) => u.file)).size).toBeGreaterThan(8);
  });

  it('todos los <Term> usan un id estático que existe en el glosario', () => {
    const ids = new Set(Object.keys(GLOSSARY));
    const broken = uses.filter((u) => u.id === null || !ids.has(u.id)).map((u) => `${where(u)} → ${u.id ?? '(id dinámico o ausente)'}`);
    expect(broken).toEqual([]);
  });

  it('todas las entradas del glosario se usan en alguna pantalla', () => {
    const used = new Set(uses.map((u) => u.id));
    const unused = Object.keys(GLOSSARY).filter((id) => !used.has(id));
    expect(unused).toEqual([]);
  });

  it('ningún término está dentro de un botón, un enlace, código o un título', () => {
    const forbidden = new Set(['button', 'a', 'RouterLink', 'code', 'pre', 'h1', 'h2', 'h3', 'option', 'summary']);
    const misplaced = uses
      .map((u) => ({ u, tag: u.ancestors.find((t) => forbidden.has(t)) }))
      .filter((x) => x.tag)
      .map((x) => `${where(x.u)} → <Term id="${x.u.id}"> dentro de <${x.tag}>`);
    expect(misplaced).toEqual([]);
  });

  it('las definiciones son frases completas, breves y sin repetir término', () => {
    const entries = glossaryEntries();
    for (const e of entries) {
      expect(e.term.trim(), e.id).not.toBe('');
      expect(e.definition.length, `${e.id}: definición demasiado corta`).toBeGreaterThanOrEqual(40);
      expect(e.definition.length, `${e.id}: definición demasiado larga para un tooltip`).toBeLessThanOrEqual(180);
      expect(e.definition.trim().endsWith('.') || e.definition.trim().endsWith('…'), `${e.id}: debe terminar en punto`).toBe(true);
    }
    const terms = entries.map((e) => e.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
    // La página Glosario los lista por orden alfabético.
    expect(terms).toEqual([...terms].sort((a, b) => a.localeCompare(b, 'es')));
  });

  it('el inglés tiene exactamente los mismos ids que el español', () => {
    expect(Object.keys(GLOSSARY_EN).sort()).toEqual(Object.keys(GLOSSARY).sort());
  });

  it('las definiciones en inglés cumplen las mismas reglas de longitud y forma', () => {
    for (const [id, e] of Object.entries(GLOSSARY_EN)) {
      expect(e.term.trim(), id).not.toBe('');
      expect(e.definition.length, `${id}: definición inglesa demasiado corta`).toBeGreaterThanOrEqual(40);
      expect(e.definition.length, `${id}: definición inglesa demasiado larga para un tooltip`).toBeLessThanOrEqual(180);
      expect(e.definition.trim().endsWith('.') || e.definition.trim().endsWith('…'), `${id}: debe terminar en punto`).toBe(true);
    }
  });

  it('con el idioma en inglés, la lista sale en inglés, sin términos repetidos y por orden alfabético', () => {
    setLocale('en', false);
    try {
      const entries = glossaryEntries();
      expect(entries.find((e) => e.id === 'agente')?.term).toBe('Agent');
      const terms = entries.map((e) => e.term.toLowerCase());
      expect(new Set(terms).size).toBe(terms.length);
      expect(terms).toEqual([...terms].sort((a, b) => a.localeCompare(b, 'en')));
    } finally {
      setLocale('es', false);
    }
  });
});
