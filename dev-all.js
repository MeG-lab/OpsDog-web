import { spawn } from 'node:child_process';

const children = [];
const isWindows = process.platform === 'win32';

const start = (name, command, args) => {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
    shell: isWindows,
  });

  const prefix = `[${name}]`;
  child.stdout.on('data', (chunk) => {
    process.stdout.write(`${prefix} ${chunk.toString()}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`${prefix} ${chunk.toString()}`);
  });

  children.push(child);
  return child;
};

const shutdown = () => {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
};

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

start('server', isWindows ? 'npm.cmd' : 'npm', ['run', 'dev:server']);
start('web', isWindows ? 'npm.cmd' : 'npm', ['run', 'dev']);
