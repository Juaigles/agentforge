// Textos del diálogo «Eliminar agente» (lib/usage.ts).
export default {
  deleteBase: 'Se eliminará «{name}».',
  deleteTail: 'Las ejecuciones anteriores se conservan en el historial.',
  deleteUnused: '{base} Ningún workflow lo usa. {tail}',
  deleteUsed:
    '{base} Lo usa {n} workflow ({names}), que dejará de poder ejecutarse hasta que le asignes otro agente. {tail} | {base} Lo usan {n} workflows ({names}), que dejarán de poder ejecutarse hasta que les asignes otro agente. {tail}',
  quoted: '«{name}»',
  andMore: '{names} y {count} más',
};
