import { readFileSync } from 'node:fs';

const MIGRATIONS = [
  {
    version: 1,
    name: 'core-assets-monitor',
    sql: readFileSync(new URL('./sql/001-core-assets-monitor.sql', import.meta.url), 'utf8'),
  },
  {
    version: 2,
    name: 'remote-access-audit',
    sql: readFileSync(new URL('./sql/002-remote-access-audit.sql', import.meta.url), 'utf8'),
  },
  {
    version: 3,
    name: 'app-auth-user-data',
    sql: readFileSync(new URL('./sql/003-app-auth-user-data.sql', import.meta.url), 'utf8'),
  },
];

export const applyMigrations = (database, { now = () => new Date().toISOString() } = {}) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  for (const migration of MIGRATIONS) {
    const applied = database.get(
      'SELECT version FROM schema_migrations WHERE version = ?',
      migration.version,
    );
    if (applied) continue;

    database.transaction(() => {
      database.exec(migration.sql);
      database.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        now(),
      );
    });
  }

  return database.all(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version',
  );
};
