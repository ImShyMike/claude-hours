import { describe, expect, test } from 'vitest'
import { people } from './db/index'
import { testDb } from './db/testing'
import {
  authenticateDevice,
  decideDeviceCode,
  findPendingCode,
  listDevices,
  loginCode,
  newUserCode,
  normalizeUserCode,
  pollDeviceCode,
  revokeDevice,
  startDeviceCode,
} from './devices'

const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, s))

async function setup() {
  const db = await testDb()
  const [ana] = await db.insert(people).values({ sub: 'ident!ana' }).returning()
  const [bo] = await db.insert(people).values({ sub: 'ident!bo' }).returning()
  return { db, ana: ana!, bo: bo! }
}

describe('user codes', () => {
  test('look like WDJB-MJHT and come back from what someone types', () => {
    for (let i = 0; i < 50; i++) {
      const code = newUserCode()
      expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
      expect(normalizeUserCode(code.toLowerCase().replace('-', ' '))).toBe(code)
    }
  })

  test('anything that cannot be a code is null', () => {
    expect(normalizeUserCode('WDJB-MJH')).toBeNull()
    expect(normalizeUserCode('WDJB-MJHA')).toBeNull() // vowel
    expect(normalizeUserCode('')).toBeNull()
  })
})

describe('the device flow', () => {
  test('pending, approved, then swapped for a token exactly once', async () => {
    const { db, ana } = await setup()
    const { deviceCode, userCode } = await startDeviceCode(db, 'ana-laptop', at(0))

    expect(await pollDeviceCode(db, deviceCode, at(5))).toEqual({ error: 'authorization_pending' })
    expect(await findPendingCode(db, userCode, at(6))).toMatchObject({ userCode, deviceName: 'ana-laptop' })
    expect(await decideDeviceCode(db, userCode, ana.id, true, at(7))).toBe(true)
    // decided codes can't be decided again, or shown as waiting
    expect(await decideDeviceCode(db, userCode, ana.id, false, at(8))).toBe(false)
    expect(await findPendingCode(db, userCode, at(8))).toBeNull()

    const result = await pollDeviceCode(db, deviceCode, at(10))
    if (!('token' in result)) throw new Error(`expected a token, got ${result.error}`)
    expect(result.token).toMatch(/^hct_/)
    expect(await pollDeviceCode(db, deviceCode, at(15))).toEqual({ error: 'invalid_grant' })

    expect((await authenticateDevice(db, result.token, at(16)))?.person.id).toBe(ana.id)
    expect(await listDevices(db, ana.id)).toMatchObject([{ name: 'ana-laptop' }])
  })

  test("a code made on the hub swaps at once, named by the mod, and can't be shown on /device", async () => {
    const { db, ana } = await setup()
    const { deviceCode, userCode } = await loginCode(db, ana.id, at(0))
    expect(await findPendingCode(db, userCode, at(1))).toBeNull()
    const result = await pollDeviceCode(db, deviceCode, at(2), 'ana-desktop')
    if (!('token' in result)) throw new Error(`expected a token, got ${result.error}`)
    expect((await authenticateDevice(db, result.token, at(3)))?.person.id).toBe(ana.id)
    expect(await listDevices(db, ana.id)).toMatchObject([{ name: 'ana-desktop' }])
    expect(await pollDeviceCode(db, deviceCode, at(4), 'ana-desktop')).toEqual({ error: 'invalid_grant' })
  })

  test('a code made on the hub runs out like any other, and the mod naming one never renames a device', async () => {
    const { db, ana } = await setup()
    const late = await loginCode(db, ana.id, at(0))
    expect(await pollDeviceCode(db, late.deviceCode, at(601))).toEqual({ error: 'expired_token' })
    // a code the mod started keeps the mod's name, whatever the poll says
    const { deviceCode, userCode } = await startDeviceCode(db, 'ana-laptop', at(700))
    await decideDeviceCode(db, userCode, ana.id, true, at(701))
    await pollDeviceCode(db, deviceCode, at(706), 'something else')
    expect(await listDevices(db, ana.id)).toMatchObject([{ name: 'ana-laptop' }])
    // and one made on the hub with no name from the mod gets a plain one
    const bare = await loginCode(db, ana.id, at(800))
    await pollDeviceCode(db, bare.deviceCode, at(801))
    expect((await listDevices(db, ana.id)).map(d => d.name).sort()).toEqual(['Claude Code', 'ana-laptop'])
  })

  test('polling faster than the interval gets slow_down', async () => {
    const { db } = await setup()
    const { deviceCode } = await startDeviceCode(db, 'x', at(0))
    expect(await pollDeviceCode(db, deviceCode, at(5))).toEqual({ error: 'authorization_pending' })
    expect(await pollDeviceCode(db, deviceCode, at(6))).toEqual({ error: 'slow_down' })
    expect(await pollDeviceCode(db, deviceCode, at(11))).toEqual({ error: 'authorization_pending' })
  })

  test('a denied code says so once, then is gone', async () => {
    const { db, ana } = await setup()
    const { deviceCode, userCode } = await startDeviceCode(db, 'x', at(0))
    expect(await decideDeviceCode(db, userCode, ana.id, false, at(1))).toBe(true)
    expect(await pollDeviceCode(db, deviceCode, at(5))).toEqual({ error: 'access_denied' })
    expect(await pollDeviceCode(db, deviceCode, at(10))).toEqual({ error: 'invalid_grant' })
  })

  test('codes expire after ten minutes and the next start sweeps them away', async () => {
    const { db, ana } = await setup()
    const { deviceCode, userCode } = await startDeviceCode(db, 'x', at(0))
    expect(await decideDeviceCode(db, userCode, ana.id, true, at(601))).toBe(false)
    expect(await pollDeviceCode(db, deviceCode, at(601))).toEqual({ error: 'expired_token' })
    await startDeviceCode(db, 'y', at(602))
    expect(await pollDeviceCode(db, deviceCode, at(603))).toEqual({ error: 'invalid_grant' })
  })

  test('only the owner can revoke a device, and a revoked token stops working', async () => {
    const { db, ana, bo } = await setup()
    const { deviceCode, userCode } = await startDeviceCode(db, 'x', at(0))
    await decideDeviceCode(db, userCode, ana.id, true, at(1))
    const { token } = (await pollDeviceCode(db, deviceCode, at(5))) as { token: string }
    const [device] = await listDevices(db, ana.id)

    expect(await revokeDevice(db, bo.id, device!.id)).toBe(false)
    expect(await authenticateDevice(db, token)).not.toBeNull()
    expect(await revokeDevice(db, ana.id, device!.id)).toBe(true)
    expect(await authenticateDevice(db, token)).toBeNull()
  })
})
