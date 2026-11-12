// Built-in tools: title, category and description for the screen, by tool name. The description the model reads
// is the server's one and does not change with the interface language.
export default {
  category: {
    utilities: 'Utilities',
    network: 'Network',
    files: 'Files',
    coordination: 'Coordination',
    code: 'Code',
    custom: 'Custom',
  },
  calculator: {
    title: 'Calculator',
    description:
      'Evaluates a mathematical expression precisely. Supports + - * / % ^, parentheses, constants (pi, e) and functions (sqrt, abs, round, floor, ceil, min, max, pow, exp, ln, log, sin, cos, tan).',
    params: { expression: 'Mathematical expression to evaluate.' },
  },
  current_datetime: {
    title: 'Current date and time',
    description: 'Returns the current date and time (ISO 8601, local time and day of the week).',
    params: { timezone: 'Optional IANA time zone, e.g. "Europe/Madrid".' },
  },
  http_request: {
    title: 'HTTP request',
    description: 'Makes an HTTP(S) request to an API and returns the status, the headers and the body (JSON when possible). Useful for querying REST APIs.',
    params: {
      url: 'Full URL (http or https).',
      method: 'HTTP method.',
      headers: 'Headers as a JSON object.',
      body: 'Request body (text or serialized JSON).',
    },
  },
  web_fetch: {
    title: 'Read web page',
    description: 'Downloads a web page and returns its content as readable text (without HTML). Useful for reading articles or documentation.',
    params: { url: 'URL of the page (http or https).', max_chars: 'Maximum number of characters to return.' },
  },
  file_write: {
    title: 'Write file',
    description: 'Writes (or overwrites) a text file in the AgentForge workspace. Useful for saving reports, data or code.',
    params: {
      path: 'Relative path inside the workspace, e.g. "informes/resumen.md".',
      content: 'Content of the file.',
      append: 'If true, appends to the end instead of overwriting.',
    },
  },
  file_read: {
    title: 'Read file',
    description: 'Reads a text file from the AgentForge workspace.',
    params: { path: 'Relative path inside the workspace.' },
  },
  file_list: {
    title: 'List files',
    description: 'Lists the files in the AgentForge workspace (recursively).',
    params: { directory: 'Optional subdirectory.' },
  },
  memory_set: {
    title: 'Save to shared memory',
    description: 'Saves a value in the shared memory of the run. Other agents of the same workflow can read it with memory_get.',
    params: { key: 'Name of the value.', value: 'Value to save.' },
  },
  memory_get: {
    title: 'Read shared memory',
    description: 'Reads a value from the shared memory of the run. Without "key" it returns the list of available keys.',
    params: { key: 'Name of the value to read (optional).' },
  },
  delegate_task: {
    title: 'Delegate to another agent',
    description:
      'Delegates a subtask to another specialized agent and returns its answer. Give complete, self-contained instructions: the other agent cannot see this conversation.',
    params: { agent: 'Exact name of the agent to delegate to.', task: 'Full description of the subtask.' },
  },
  run_javascript: {
    title: 'Run JavaScript',
    description:
      'Runs JavaScript code in an isolated environment (no access to the network, the disk or modules) and returns the value of the last expression and whatever was printed with console.log. Useful for calculations and data transformation.',
    params: { code: 'JavaScript code. The last expression is the result.' },
  },
};
