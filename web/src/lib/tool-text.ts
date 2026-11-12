// Textos de una herramienta para la pantalla. Las integradas se rotulan por su nombre con los textos de la
// interfaz (`builtinTools.<nombre>`), en el idioma activo; las personalizadas y las de servidores MCP llevan los
// textos que escribió quien las creó, tal cual. La descripción que lee el modelo es la del servidor y no pasa por aquí.
import type { JsonSchemaProp, ToolInfo } from '@shared/types';
import { t, te } from '@/i18n';

/** Categoría de cada herramienta integrada (clave de `builtinTools.category`). */
export const BUILTIN_CATEGORY: Record<string, string> = {
  calculator: 'utilities',
  current_datetime: 'utilities',
  http_request: 'network',
  web_fetch: 'network',
  file_write: 'files',
  file_read: 'files',
  file_list: 'files',
  memory_set: 'coordination',
  memory_get: 'coordination',
  delegate_task: 'coordination',
  run_javascript: 'code',
};

type Tool = Pick<ToolInfo, 'name' | 'title' | 'description' | 'category' | 'source'>;

/** ¿Es una herramienta integrada que esta versión de la interfaz conoce? (Una nueva del servidor se muestra con sus textos.) */
const known = (tool: Pick<ToolInfo, 'name' | 'source'>): boolean => tool.source === 'builtin' && Object.hasOwn(BUILTIN_CATEGORY, tool.name);

export function toolTitle(tool: Tool): string {
  return known(tool) ? t(`builtinTools.${tool.name}.title`) : tool.title;
}

export function toolDescription(tool: Tool): string {
  return known(tool) ? t(`builtinTools.${tool.name}.description`) : tool.description;
}

export function toolCategory(tool: Tool): string {
  if (known(tool)) return t(`builtinTools.category.${BUILTIN_CATEGORY[tool.name]}`);
  return tool.source === 'custom' ? t('builtinTools.category.custom') : tool.category;
}

/** Descripción de un parámetro de la herramienta. */
export function toolParamDescription(tool: Pick<ToolInfo, 'name' | 'source'>, param: string, prop: Pick<JsonSchemaProp, 'description'>): string {
  const key = `builtinTools.${tool.name}.params.${param}`;
  return known(tool) && te(key) ? t(key) : (prop.description ?? '');
}
