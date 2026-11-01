import { OAuth2Client } from 'google-auth-library';
import { ApiError } from './errors';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

/** Valida el idToken de Google contra todos los Client ID permitidos (web y Android). */
export function googleVerifier(clientIds: string[]): GoogleVerifier {
  const client = new OAuth2Client();
  return async idToken => {
    if (clientIds.length === 0) throw new ApiError(500, 'google_not_configured', 'Google Sign-In no está configurado.');
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientIds });
      payload = ticket.getPayload();
    } catch {
      throw new ApiError(401, 'invalid_google_token', 'El token de Google no es válido.');
    }
    if (!payload?.sub || !payload.email) {
      throw new ApiError(401, 'invalid_google_token', 'El token de Google no es válido.');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? payload.email,
      picture: payload.picture ?? null,
    };
  };
}
