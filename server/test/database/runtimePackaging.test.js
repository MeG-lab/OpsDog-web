import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('backend runtime and test bundle declare Node.js 24 persistence boundaries', async () => {
  const [packageText, gitignore, bundleScript] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, '.gitignore'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'scripts/package-test-bundle.mjs'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.engines?.node, '>=24.0.0');
  assert.match(gitignore, /^server\/data\/opsdog\/$/m);
  assert.match(bundleScript, /Node\.js 24 LTS/);
  assert.doesNotMatch(bundleScript, /Node\.js 18\+/);
  assert.match(bundleScript, /远程凭据功能当前为开发验证范围/);
});

test('Docker runtime includes common connectivity diagnostics for generated tasks', async () => {
  const dockerfile = await readFile(path.join(PROJECT_ROOT, 'Dockerfile'), 'utf8');
  const runtimeStage = dockerfile.slice(dockerfile.indexOf('# --- Runtime ---'));

  assert.match(runtimeStage, /iputils-ping/);
  assert.match(runtimeStage, /\bcurl\b/);
});

test('Docker deployment bundle builds and runs OpsDog with persistent data', async () => {
  const [packageText, dockerfile, deployScript, packageScript] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'deploy/docker/Dockerfile'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'deploy/docker/one-click-docker-deploy.sh'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'scripts/package-docker-deploy.mjs'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.scripts['package:docker'], 'npm run build && node scripts/package-docker-deploy.mjs');
  assert.ok(packageJson.dependencies?.['@modelcontextprotocol/server-filesystem']);

  assert.match(dockerfile, /FROM node:22-bookworm-slim/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /COPY dist \.\/dist/);
  assert.match(dockerfile, /COPY server \.\/server/);
  assert.match(dockerfile, /COPY tools \.\/tools/);
  assert.match(dockerfile, /EXPOSE 8788/);
  assert.match(dockerfile, /CMD \["node", "server\/src\/index\.js"\]/);

  assert.match(deployScript, /install_docker\(\)/);
  assert.match(deployScript, /docker build/);
  assert.doesNotMatch(deployScript, /build_args\[@\]/);
  assert.match(deployScript, /docker run -d/);
  assert.match(deployScript, /--restart unless-stopped/);
  assert.match(deployScript, /"\$DATA_DIR:\/app\/server\/data"/);
  assert.match(deployScript, /"\$LOGS_DIR:\/app\/logs"/);
  assert.match(deployScript, /\/opt\/opsdog\/stop-linux\.sh/);
  assert.match(deployScript, /stop_legacy_port_conflicts/);
  assert.match(deployScript, /server\/src\/index\.js/);
  assert.match(deployScript, /\/api\/health/);

  assert.match(packageScript, /OpsDog-docker-\$\{timestamp\}/);
  assert.match(packageScript, /deploy', 'docker', 'Dockerfile/);
  assert.match(packageScript, /writeCleanServerData/);
  assert.match(packageScript, /writeCleanScriptData/);
  assert.match(packageScript, /tools', 'script'/);
  assert.match(packageScript, /tools', 'script', 'instant'/);
  assert.match(packageScript, /tools', 'script', 'managed'/);
  assert.match(packageScript, /node:\s*'>=22\.0\.0'/);
  assert.match(packageScript, /node_modules/);
  assert.match(packageScript, /\['--no-xattrs', '-czf', tarPath, packageName\]/);
});
