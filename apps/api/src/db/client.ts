import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as schema from './schema';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

export function connect(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return { pool, db: drizzle(pool, { schema }) };
}

export async function runMigrations(connectionString: string): Promise<void> {
  const { pool, db } = connect(connectionString);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
