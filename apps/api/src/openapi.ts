/** Escribe docs/openapi.yaml, o con --check falla si no coincide con el contrato. */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { buildApp } from './app';
import type { Db } from './repo';

export const openapiPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/openapi.yaml');

export async function generateOpenApi(): Promise<string> {
  const app = await buildApp({
    db: {} as Db,
    jwtSecret: 'solo-para-generar-openapi',
    verifier: async () => { throw new Error('sin uso'); },
  });
  await app.ready();
  const text = stringify(app.swagger());
  await app.close();
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = await generateOpenApi();
  if (process.argv.includes('--check')) {
    if (readFileSync(openapiPath, 'utf8') !== text) {
      console.error('docs/openapi.yaml está desactualizado: corré pnpm openapi');
      process.exit(1);
    }
  } else {
    writeFileSync(openapiPath, text);
  }
}
