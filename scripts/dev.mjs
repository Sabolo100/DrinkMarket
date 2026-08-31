/** Fejlesztoi indito: api + worker + scheduler + web egyszerre. */
import { spawn } from 'node:child_process';

const services = [
  { name: 'api',       cmd: 'npm', args: ['run', 'dev:api'],       color: '\x1b[35m' },
  { name: 'worker',    cmd: 'npm', args: ['run', 'dev:worker'],    color: '\x1b[36m' },
  { name: 'scheduler', cmd: 'npm', args: ['run', 'dev:scheduler'], color: '\x1b[33m' },
  { name: 'web',       cmd: 'npm', args: ['run', 'dev:web'],       color: '\x1b[32m' },
];

const children = services.map((s) => {
  const child = spawn(s.cmd, s.args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${s.color}[${s.name.padEnd(9)}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (buf) => {
      for (const line of String(buf).split('\n')) {
        if (line.trim()) process.stdout.write(prefix + line + '\n');
      }
    });
  }
  return child;
});

const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
