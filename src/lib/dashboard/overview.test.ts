import { expect, test } from 'vitest'
import { toolName } from './overview'

test('MCP tools read as their server and tool, prefixes dropped', () => {
  expect(toolName('mcp__helium-devtools__take_screenshot')).toBe('helium-devtools · take screenshot')
  expect(toolName('mcp__plugin_engineering_slack__slack_read_thread')).toBe('slack · read thread')
  expect(toolName('mcp__claude_ai_Airtable__list_bases')).toBe('Airtable · list bases')
  expect(toolName('mcp__claude_ai_Claude_Docs__batch')).toBe('Claude Docs · batch')
  expect(toolName('mcp__hackclub-documentation__getPage')).toBe('hackclub-documentation · getPage')
  expect(toolName('Bash')).toBe('Bash')
})
