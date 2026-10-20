// The central server's side: people's tokens, and the uploads hook-analytics
// sends. Each person's files land in <hub>/people/<person>/ laid out like
// ~/.claude/analytics, so the dashboard reads them the same way.
//
// An upload is the bytes of a session file past what the hub already holds:
// POST /v1/sessions/<id>/<events|drafts>?offset=<bytes>. The hub appends what
// it doesn't have yet and answers its new length, or 409 with its length when
// the offset is past it, so a repeated or half-finished send is always safe.

import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_ID } from './load'

export const KINDS = ['events', 'drafts'] as const
export type Kind = (typeof KINDS)[number]

// one upload's most; the mod sends 512 KiB at a time
export const MAX_BODY = 4 * 1024 * 1024
export const PERSON = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type Person = { person: string; admin?: boolean }
// tokens.json keys are sha256(token), so the file alone lets no one in
type Tokens = Record<string, Person>

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export async function readTokens(hub: string): Promise<Tokens> {
  try {
    return JSON.parse(await readFile(join(hub, 'tokens.json'), 'utf8'))
  } catch {
    return {}
  }
}

// a new token for a person; only its hash is kept
export async function mintToken(hub: string, person: string, admin = false) {
  if (!PERSON.test(person)) throw new Error(`a person is lowercase letters, digits, - and _: ${person}`)
  const tokens = await readTokens(hub)
  const token = randomBytes(24).toString('base64url')
  tokens[hash(token)] = admin ? { person, admin } : { person }
  await mkdir(hub, { recursive: true })
  const tmp = join(hub, `tokens.json.${process.pid}`)
  await writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, join(hub, 'tokens.json'))
  return token
}

export async function whoIs(hub: string, token: string | undefined): Promise<Person | undefined> {
  if (!token) return undefined
  const found = (await readTokens(hub))[hash(token)]
  return found && PERSON.test(found.person) ? found : undefined
}

export const bearer = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]

export const COOKIE = 'hackatime'
export const cookieToken = (req: Request) =>
  (req.headers.get('cookie') ?? '')
    .split(';')
    .map(part => part.trim().split('='))
    .find(([name]) => name === COOKIE)?.[1]

export const personDir = (hub: string, person: string) => join(hub, 'people', person)

export async function people(hub: string) {
  const names = await readdir(join(hub, 'people')).catch(() => [])
  return names.filter(name => PERSON.test(name)).sort()
}

// the byte at `at`, or undefined past the end
async function byteAt(path: string, at: number) {
  const file = await open(path, 'r')
  try {
    const one = new Uint8Array(1)
    const { bytesRead } = await file.read(one, 0, 1, at)
    return bytesRead ? one[0] : undefined
  } finally {
    await file.close()
  }
}

// appends to one file never overlap, even with two sends in flight
const locks = new Map<string, Promise<unknown>>()
function serially<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => {})
  locks.set(key, settled)
  void settled.then(() => locks.get(key) === settled && locks.delete(key))
  return next
}

export type Ingested = { status: 200 | 409; length: number }

// The bytes past what the file holds go on its end. `offset` is where the
// sender thinks the file ends; only whole lines ever move
export function ingest(path: string, offset: number, body: Uint8Array): Promise<Ingested> {
  return serially(path, async () => {
    const length = await stat(path).then(
      s => s.size,
      () => 0,
    )
    if (offset > length) return { status: 409, length }
    // a send starts where a line of the file does, and ends with one
    if (offset > 0 && (await byteAt(path, offset - 1)) !== 10) return { status: 409, length }
    const skip = length - offset
    if (skip >= body.length) return { status: 200, length }
    // what we already hold has to end where a line of the body does
    if (skip > 0 && body[skip - 1] !== 10) return { status: 409, length }
    await mkdir(join(path, '..'), { recursive: true })
    await appendFile(path, body.subarray(skip))
    return { status: 200, length: length + body.length - skip }
  })
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

// POST /v1/sessions/:id/:kind?offset=N, with the person's token as a bearer
export async function upload(hub: string, req: Request, id: string, kind: string) {
  // the bearer header only: a browser's cookie never uploads
  const who = await whoIs(hub, bearer(req))
  if (!who) return json({ error: 'unknown token' }, 401)
  if (!SESSION_ID.test(id) || !(KINDS as readonly string[]).includes(kind)) return json({ error: 'no such file' }, 404)
  const offset = Number(new URL(req.url).searchParams.get('offset'))
  if (!Number.isSafeInteger(offset) || offset < 0) return json({ error: 'offset must be a byte count' }, 400)
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'too big' }, 413)
  const body = new Uint8Array(await req.arrayBuffer())
  if (body.length > MAX_BODY) return json({ error: 'too big' }, 413)
  if (!body.length || body[body.length - 1] !== 10) return json({ error: 'send whole lines' }, 400)
  const { status, length } = await ingest(join(personDir(hub, who.person), kind, `${id}.jsonl`), offset, body)
  return json({ length }, status)
}

// Whose data a dashboard request reads: your own, or anyone's for an admin
// passing ?person=
export async function viewer(hub: string, req: Request) {
  const who = await whoIs(hub, cookieToken(req))
  if (!who) return undefined
  const asked = new URL(req.url).searchParams.get('person')
  const person = who.admin && asked && PERSON.test(asked) ? asked : who.person
  return { who, dir: personDir(hub, person), person }
}
