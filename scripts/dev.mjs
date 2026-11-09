// Arranca el servidor (API) y Vite (frontend) a la vez para desarrollo.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', 'server'], { stdio: 'inherit', shell: true }),
  spawn('npm', ['run', 'dev', '-w', 'web'], { stdio: 'inherit', shell: true }),
];

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const p of procs) p.kill();
  process.exit(code);
}

for (const p of procs) p.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
