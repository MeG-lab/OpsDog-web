import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DATABASE_PATH = path.resolve(process.cwd(), 'server/data/opsdog/opsdog.db');

const normalizeRow = (row) => row == null ? row : { ...row };

export const openSqliteAdapter = ({ databasePath = DEFAULT_DATABASE_PATH } = {}) => {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const nativeDatabase = new DatabaseSync(databasePath);
  nativeDatabase.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);

  return {
    databasePath,
    exec: (sql) => nativeDatabase.exec(sql),
    run: (sql, ...values) => nativeDatabase.prepare(sql).run(...values),
    get: (sql, ...values) => normalizeRow(nativeDatabase.prepare(sql).get(...values)),
    all: (sql, ...values) => nativeDatabase.prepare(sql).all(...values).map(normalizeRow),
    transaction: (work) => {
      nativeDatabase.exec('BEGIN IMMEDIATE;');
      try {
        const result = work();
        nativeDatabase.exec('COMMIT;');
        return result;
      } catch (error) {
        nativeDatabase.exec('ROLLBACK;');
        throw error;
      }
    },
    close: () => nativeDatabase.close(),
  };
};
