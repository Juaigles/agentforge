// Texts of the import review dialog (ImportModal.vue).
export default {
  title: 'Import “{name}”',
  cannotImport: "Can't import “{fileName}”.",
  introWithItems:
    'The {workflow} {name} will be created along with what it needs. Review what to do with each item: nothing is created until you press “Import”.',
  introAlone: 'The {workflow} {name} will be created. It does not depend on anything else.',
  introWorkflow: 'workflow',
  introFile: 'Review what to do with each item in the file: nothing is created until you press “Import”.',
  itemAria: 'What to do with {name}',
  providerAria: 'Provider to use here for {name}',
  kind: {
    provider: 'Providers',
    tool: 'HTTP tools',
    agent: 'Agents',
    workflow: 'Subworkflows',
  },
  action: {
    create: 'Create',
    createCopy: 'Create a copy',
    reuseProvider: 'Use an existing one',
    reuseFeminine: 'Use the existing one',
    reuseMasculine: 'Use the existing one',
    replaceFeminine: 'Replace the existing one',
    replaceMasculine: 'Replace the existing one',
    skip: "Don't import",
  },
  status: {
    newFeminine: 'New',
    newMasculine: 'New',
    differs: 'Exists, but is different',
    exists: 'Already exists',
  },
};
