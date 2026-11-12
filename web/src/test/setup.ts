// Preparación común de los tests del frontend: la interfaz se prueba en español (el idioma de referencia) y los
// componentes montados reciben la instancia de idiomas, como en la aplicación.
import { config } from '@vue/test-utils';
import { i18n, setLocale } from '@/i18n';

setLocale('es', false);
config.global.plugins = [...(config.global.plugins ?? []), i18n];
