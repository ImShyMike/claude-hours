import { people, type Db, type Person } from '@claude-hours/db'

// what Hack Club Auth tells us about someone, from the ID token or userinfo
export interface HcaClaims {
  sub: string
  name?: string
  email?: string
  email_verified?: boolean
  slack_id?: string
  verification_status?: string
}

// called on every login: a new sub makes a person, a known one gets its
// details refreshed (a name or email can change on the Hack Club Auth side)
export async function upsertPerson(db: Db, claims: HcaClaims, now = new Date()) {
  const fields = {
    name: claims.name ?? null,
    email: claims.email ?? null,
    emailVerified: claims.email_verified === true,
    slackId: claims.slack_id ?? null,
    verificationStatus: claims.verification_status ?? null,
    lastLoginAt: now,
  }
  const [person] = await db
    .insert(people)
    .values({ sub: claims.sub, ...fields })
    .onConflictDoUpdate({ target: people.sub, set: fields })
    .returning()
  return person!
}

// adminEmails is already lowercased (see src/env.ts)
export function isAdmin(person: Person, adminEmails: string[]) {
  return person.emailVerified && !!person.email && adminEmails.includes(person.email.toLowerCase())
}
