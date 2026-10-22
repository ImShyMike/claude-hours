// Hack Club Auth over OpenID Connect. It's a confidential client (the secret
// stays on the server) and HCA doesn't advertise PKCE, so state and nonce are
// what tie a callback to the login that started it
import * as client from 'openid-client'
import { HCA_CLIENT_ID, HCA_CLIENT_SECRET, HCA_ISSUER } from '$app/env/private'

// holds state, nonce and where to go after, from /auth/login to /auth/callback
export const OIDC_COOKIE = 'oidc'

export const SCOPES = 'openid profile email name slack_id verification_status'

let config: Promise<client.Configuration> | undefined

// discovery runs once per process; a failed one is retried on the next login
export function hca() {
  config ??= client.discovery(new URL(HCA_ISSUER), HCA_CLIENT_ID, HCA_CLIENT_SECRET).catch(err => {
    config = undefined
    throw err
  })
  return config
}
