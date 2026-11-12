// Texts for a tool's playground (the "Test" modal).
export default {
  title: 'Test {title}',
  intro: 'Runs the real {tool} {name} on the server, using the current security settings.',
  introTool: 'tool',
  noParams: "This tool doesn't need any parameters.",
  required: 'required',
  type: {
    string: 'text',
    number: 'number',
    integer: 'integer',
    boolean: 'yes/no',
    object: 'JSON object',
    array: 'JSON list',
    other: 'value',
  },
  select: 'Select…',
  useDefault: '(default)',
  errors: {
    required: 'This parameter is required.',
    notNumber: 'Must be a number.',
    notInteger: 'Must be an integer.',
    notArray: 'Must be a JSON list: [ … ]',
    notObject: "Must be a JSON object: {'{ … }'}",
    invalidJson: 'Invalid JSON.',
  },
  result: {
    ok: 'Ran successfully',
    failed: 'The tool returned an error',
    empty: '(empty result)',
  },
  running: 'Running…',
};
