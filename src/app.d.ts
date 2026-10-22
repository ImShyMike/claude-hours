// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Person } from '#lib/server/db/index.js'

declare global {
  namespace App {
    interface Locals {
      // null when logged out
      person: Person | null
      admin: boolean
    }
  }
}

export {}
