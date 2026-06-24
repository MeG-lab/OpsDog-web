import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';

test('adapter creates a WAL database with foreign keys enabled', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-db-adapter-'));
  const database = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });

  try {
    assert.equal(String(database.get('PRAGMA journal_mode').journal_mode).toLowerCase(), 'wal');
    assert.equal(database.get('PRAGMA foreign_keys').foreign_keys, 1);

    database.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (parent_id TEXT REFERENCES parent(id));
    `);

    assert.throws(
      () => database.run("INSERT INTO child (parent_id) VALUES ('missing')"),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('adapter transaction rolls back failed work', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-db-transaction-'));
  const database = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });

  try {
    database.exec('CREATE TABLE values_table (value TEXT NOT NULL);');

    assert.throws(() => database.transaction(() => {
      database.run('INSERT INTO values_table (value) VALUES (?)', 'discard-me');
      throw new Error('rollback requested');
    }), /rollback requested/);

    assert.deepEqual(database.all('SELECT value FROM values_table'), []);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
