import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import * as schema from './db/schema';
import { ApiError } from './errors';
import type { Tx } from './repo';

/**
 * Ejecuta `fn` una sola vez por Idempotency-Key, en la misma transacción que la
 * clave. Una request paralela con la misma clave espera el commit por el índice
 * único y recibe la respuesta guardada; si la primera falla, la clave se revierte
 * con ella y el reintento vuelve a ejecutarse.
 */
export async function idempotent<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const header = req.headers['idempotency-key'];
  if (typeof header !== 'string' || header.length < 8 || header.length > 128) {
    throw new ApiError(400, 'idempotency_key_required', 'Falta el header Idempotency-Key.');
  }
  const key = `${req.method} ${req.url.split('?')[0]} ${header}`;
  const groupId = req.group.id;

  return req.server.db.transaction(async tx => {
    const inserted = await tx.insert(schema.idempotencyKeys)
      .values({ groupId, key }).onConflictDoNothing().returning({ key: schema.idempotencyKeys.key });
    if (inserted.length === 0) {
      const [stored] = await tx.select({ response: schema.idempotencyKeys.response })
        .from(schema.idempotencyKeys)
        .where(and(eq(schema.idempotencyKeys.groupId, groupId), eq(schema.idempotencyKeys.key, key)));
      return stored.response as T;
    }
    const result = await fn(tx);
    await tx.update(schema.idempotencyKeys).set({ status: 200, response: result as object })
      .where(and(eq(schema.idempotencyKeys.groupId, groupId), eq(schema.idempotencyKeys.key, key)));
    return result;
  });
}
