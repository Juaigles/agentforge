// Textos de la revisión de una importación (ImportModal.vue).
export default {
  title: 'Importar «{name}»',
  cannotImport: 'No se puede importar «{fileName}».',
  introWithItems: 'Se creará el {workflow} {name} junto con lo que necesita. Revisa qué hacer con cada elemento: nada se crea hasta que pulses «Importar».',
  introAlone: 'Se creará el {workflow} {name}. No depende de nada más.',
  introWorkflow: 'workflow',
  introFile: 'Revisa qué hacer con cada elemento del archivo: nada se crea hasta que pulses «Importar».',
  itemAria: 'Qué hacer con {name}',
  providerAria: 'Proveedor de aquí para {name}',
  kind: {
    provider: 'Proveedores',
    tool: 'Herramientas HTTP',
    agent: 'Agentes',
    workflow: 'Subworkflows',
  },
  action: {
    create: 'Crear',
    createCopy: 'Crear una copia',
    reuseProvider: 'Usar uno de aquí',
    reuseFeminine: 'Usar la de aquí',
    reuseMasculine: 'Usar el de aquí',
    replaceFeminine: 'Sustituir la de aquí',
    replaceMasculine: 'Sustituir el de aquí',
    skip: 'No importar',
  },
  status: {
    newFeminine: 'Nueva',
    newMasculine: 'Nuevo',
    differs: 'Existe, pero es distinto',
    exists: 'Ya existe',
  },
};
