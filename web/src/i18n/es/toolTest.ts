// Textos del banco de pruebas de una herramienta (modal «Probar»).
export default {
  title: 'Probar {title}',
  intro: 'Se ejecuta la {tool} real {name} en el servidor, con los ajustes de seguridad actuales.',
  introTool: 'herramienta',
  noParams: 'Esta herramienta no necesita parámetros.',
  required: 'obligatorio',
  type: {
    string: 'texto',
    number: 'número',
    integer: 'entero',
    boolean: 'sí/no',
    object: 'objeto JSON',
    array: 'lista JSON',
    other: 'valor',
  },
  select: 'Selecciona…',
  useDefault: '(por defecto)',
  errors: {
    required: 'Este parámetro es obligatorio.',
    notNumber: 'Debe ser un número.',
    notInteger: 'Debe ser un número entero.',
    notArray: 'Debe ser una lista JSON: [ … ]',
    notObject: "Debe ser un objeto JSON: {'{ … }'}",
    invalidJson: 'JSON no válido.',
  },
  result: {
    ok: 'Ejecutada correctamente',
    failed: 'La herramienta devolvió un error',
    empty: '(resultado vacío)',
  },
  running: 'Ejecutando…',
};
