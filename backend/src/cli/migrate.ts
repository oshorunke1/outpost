// Applies pending migrations to DATABASE_URL. Compose's migrate service and CI run this.
import { createPool, pingDb } from '../platform/db.js';
import { MIGRATIONS_DIR, loadMigrations, migrate } from '../platform/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = createPool(url, { multipleStatements: true, connectionLimit: 1 });
try {
  await pingDb(db);
  const applied = await migrate(db, loadMigrations(MIGRATIONS_DIR));
  console.log(applied.length > 0 ? `applied migrations ${applied.join(', ')}` : 'the database is up to date');
} finally {
  await db.end();
}
