export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} no encontrado.`);
export const sessionClosed = () => new ApiError(409, 'session_closed', 'La partida ya está cerrada.');
