export type Window = { percent: number; resetsAt?: number }

export type Usage = {
  fiveHour?: Window
  week?: Window
  context?: number
}

// What the last main-thread request carried.
export type Request = { model?: string; effort?: string }

// What /effort and /advisor keep in settings.
export type Chosen = { effort?: string; advisor?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-line': {
      usage: Usage | null
      request: Request
      settings: Chosen
      // The 5h window's time left as drawn ('2h 30m'); '' when it has none.
      countdown: string
      alerted: readonly string[]
    }
  }
}
