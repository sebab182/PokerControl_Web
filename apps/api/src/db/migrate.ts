import { runMigrations } from './client';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Falta DATABASE_URL');
await runMigrations(url);
console.log('Migraciones aplicadas.');
