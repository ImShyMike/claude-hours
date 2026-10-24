// Session ids whose start was already logged, so a hot reload (which runs
// session.start again) doesn't log a second start.
export type StartedSessions = string[]

// The transcript's compact_boundary uuids already looked at, logged or not,
// so a compaction found there is logged once.
export type SeenCompactions = string[]

// The last permission mode logged from the transcript's prompts and when it
// was sent, so a later look carries on from there.
export type LastMode = { sessionId: string; at: number; mode: string } | null

// How far into its transcript the session has been read, in bytes, so the
// next look reads only what was added.
export type TranscriptRead = { sessionId: string; bytes: number } | null

declare module 'claude-code' {
  interface PluginState {
    'time-track': { startedSessions: StartedSessions; seenCompactions: SeenCompactions; lastMode: LastMode; transcriptRead: TranscriptRead }
  }
}
