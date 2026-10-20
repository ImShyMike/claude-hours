// Mints a token for one person on the hub, and prints the config.json bit
// they paste in. Only its hash is kept, so a lost token means a new one.
//
//   HUB_DIR=/srv/hackatime bun scripts/hub-token.ts <person> [--admin] [--url https://hub.example]

import { mintToken } from '../src/hub'

const args = process.argv.slice(2)
const hub = process.env.HUB_DIR
const at = args.indexOf('--url')
const url = at >= 0 ? args[at + 1] : 'https://your-hub.example'
const person = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1))
if (!hub || !person || !url) {
  console.error('usage: HUB_DIR=<dir> bun scripts/hub-token.ts <person> [--admin] [--url <hub url>]')
  process.exit(1)
}

const token = await mintToken(hub, person, args.includes('--admin'))
console.log(`token for ${person}: ${token}\n`)
console.log('their ~/.claude/analytics/config.json (chmod 600 it):')
console.log(JSON.stringify({ server: { url, token } }, null, 2))
