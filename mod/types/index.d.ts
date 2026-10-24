// Session ids whose start was already logged, so a hot reload (which runs
// session.start again) doesn't log a second start.
export type StartedSessions = string[]

// The transcript's compact_boundary uuids already looked at, logged or not,
// so a compaction found there is logged once.
export type SeenCompactions = string[]

declare module 'claude-code' {
  interface PluginState {
    'time-track': { startedSessions: StartedSessions; seenCompactions: SeenCompactions }
  }
}
