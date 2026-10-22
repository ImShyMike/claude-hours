import { defineEnvVars } from '@sveltejs/kit/env'

// Kit checks env vars during `vite build` too, but these only exist where the
// hub runs, so a missing one is '' here and init in hooks.server.ts refuses
// to start without it
const required = (value: string | undefined) => value ?? ''

export const variables = defineEnvVars({
  DATABASE_URL: { description: 'Postgres connection string, e.g. postgres://user:pass@host:5432/db', schema: required },
  HCA_CLIENT_ID: { description: 'Client id of the app registered at https://auth.hackclub.com/developer/apps', schema: required },
  HCA_CLIENT_SECRET: { description: 'Client secret of that same app', schema: required },
  HCA_ISSUER: {
    description: 'Hack Club Auth issuer, only worth changing to point at a staging instance',
    schema: value => value || 'https://auth.hackclub.com',
  },
  ADMIN_EMAILS: {
    description: 'Comma separated emails that get admin, matched against verified Hack Club Auth emails',
    schema: value =>
      (value ?? '')
        .split(',')
        .map(email => email.trim().toLowerCase())
        .filter(Boolean),
  },
})
