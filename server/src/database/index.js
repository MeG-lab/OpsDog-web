import path from 'node:path';
import { importJsonAssets } from './jsonAssetImporter.js';
import { applyMigrations } from './migrations.js';
import { openSqliteAdapter } from './sqliteAdapter.js';

export const initializeFoundationDatabase = async (options = {}) => {
  const database = openSqliteAdapter({ databasePath: options.databasePath });

  try {
    const migrations = applyMigrations(database, { now: options.now });
    const backupRoot = options.backupRoot
      || path.join(path.dirname(database.databasePath), 'backups');
    const importResult = options.assetsDir
      ? await importJsonAssets({
        database,
        assetsDir: options.assetsDir,
        backupRoot,
        now: options.now,
        createId: options.createId,
      })
      : null;

    return { database, migrations, importResult };
  } catch (error) {
    database.close();
    throw error;
  }
};
