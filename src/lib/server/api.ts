import { json } from '@sveltejs/kit'

// the mod's API speaks JSON only: SvelteKit's origin check turns away form
// posts with no Origin header, which is every request a CLI makes
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null
  } catch {
    return null
  }
}

// RFC 6749 style error bodies, which the device flow (RFC 8628) builds on
export const oauthError = (error: string, status = 400, init?: ResponseInit) => json({ error }, { status, ...init })

export const bearerOf = (request: Request) => request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]

export const unauthorized = () => oauthError('invalid_token', 401, { headers: { 'www-authenticate': 'Bearer' } })
