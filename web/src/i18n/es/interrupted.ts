// Textos del aviso de ejecuciones interrumpidas por un apagado del servidor (InterruptedBanner).
export default {
  title: 'Una ejecución se interrumpió al apagarse el servidor. | {n} ejecuciones se interrumpieron al apagarse el servidor.',
  body: 'Puedes reanudar cada {run} donde se quedó: los pasos que ya habían terminado se reutilizan y solo se repite el resto.',
  bodyRun: 'ejecución',
  more: 'y {n} más',
  resume: 'Reanudar | Reanudar todas',
  dismiss: 'Descartar',
  toast: {
    resumedOne: '«{name}» se ha reanudado.',
    resumedMany: '{n} ejecución reanudada. | {n} ejecuciones reanudadas.',
  },
};
