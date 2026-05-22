import { spawn } from 'node:child_process';

const children = [];
const isWindows = process.platform === 'win32';

const start = (name, command, args) => {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
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

const startNpmScript = (name, scriptName) => {
  if (process.env.npm_execpath) {
    return start(name, process.execPath, [process.env.npm_execpath, 'run', scriptName]);
  }

  if (isWindows) {
    return start(name, process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'run', scriptName]);
  }

  return start(name, 'npm', ['run', scriptName]);
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

startNpmScript('server', 'dev:server');
startNpmScript('web', 'dev');
