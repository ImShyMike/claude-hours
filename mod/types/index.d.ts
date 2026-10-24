// Session ids whose start was already logged, so a hot reload (which runs
// session.start again) doesn't log a second start.
export type StartedSessions = string[]

// The transcript's compact_boundary uuids already looked at, logged or not,
// so a compaction found there is logged once.
export type SeenCompactions = string[]

// The last permission mode logged and when, by the classic hooks or from the
// transcript's prompts, so neither logs it again.
export type LastMode = { sessionId: string; at: number; mode: string } | null

declare module 'claude-code' {
  interface PluginState {
    'time-track': { startedSessions: StartedSessions; seenCompactions: SeenCompactions; lastMode: LastMode }
  }
}
