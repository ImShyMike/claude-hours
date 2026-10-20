// Session ids whose start was already logged, so a hot reload (which runs
// session.start again) doesn't log a second start.
export type StartedSessions = string[]

declare module 'claude-code' {
  interface PluginState {
    'hook-analytics': { startedSessions: StartedSessions }
  }
}
