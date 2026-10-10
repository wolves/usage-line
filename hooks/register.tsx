import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { Usage, Window } from '../types'

// The figures from session.measure, the model and effort the last main-thread
// request carried, the effort and advisor as /effort and /advisor keep them in
// settings, the 5h window's countdown as drawn, and the alerts already shown.
const usage = atom({ plugin: 'usage-line', key: 'usage' } as const, null)
const request = atom({ plugin: 'usage-line', key: 'request' } as const, {})
const settings = atom({ plugin: 'usage-line', key: 'settings' } as const, {})
const countdown = atom({ plugin: 'usage-line', key: 'countdown' } as const, '')
const alerted = atom({ plugin: 'usage-line', key: 'alerted' } as const, [])

const LABELS = { fiveHour: '5h', week: 'wk', context: 'ctx' } as const

// The terminal's own palette, as the old status line's ANSI codes drew it.
// A bare name like 'yellow' validates but is not drawn, and `dimColor` is the
// theme's grey rather than ANSI dim, replacing any color it is set beside.
const YELLOW = 'ansi256(3)'
const WHITE = 'ansi256(7)'
const RED = 'ansi256(1)'

// Effort warms as it rises; low is left in the theme's grey. A level not
// listed here (a numeric budget) is drawn white.
const EFFORT_COLORS: Readonly<Record<string, string | undefined>> = {
  low: undefined,
  medium: WHITE,
  high: 'ansi256(6)',
  xhigh: 'ansi256(4)',
  max: 'ansi256(5)',
}

const toWindow = (limit: SessionRateLimit | undefined): Window | undefined =>
  limit && {
    percent: limit.percentUsed,
    resetsAt: limit.resetsAt ? Date.parse(limit.resetsAt) : undefined,
  }

const toUsage = (e: Pick<SessionUsage, 'context' | 'rateLimits'>): Usage => ({
  fiveHour: toWindow(e.rateLimits.find(l => l.kind === 'five_hour')),
  week: toWindow(e.rateLimits.find(l => l.kind === 'seven_day')),
  context: e.context.percent,
})

const percentOf = (figures: Usage, key: keyof typeof LABELS) =>
  key === 'context' ? figures.context : figures[key]?.percent

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

// "claude-opus-5-5[1m]" -> "Opus 5.5 [1m]"; anything else passes through.
export const prettyModel = (id: string): string => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[.+\])?$/.exec(id)
  if (!match) return id
  const [, family = '', major, minor, suffix] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return `${name} ${major}${minor ? `.${minor}` : ''}${suffix ? ` ${suffix}` : ''}`
}

export const formatRemaining = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Values a timer or every request writes again are compared first, so an
// unchanged one redraws nothing.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Toasts each figure once per threshold it crosses (once in all when a jump
// crosses several), and forgets a threshold when the figure drops back under
// it (a window reset, a compaction) so it can fire again.
async function alert($: EngineInterface, figures: Usage, thresholds: readonly number[]) {
  const fired = new Set(await read($, alerted))

  for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
    const value = percentOf(figures, key) ?? 0
    const crossed = thresholds.filter(t => value >= t && !fired.has(`${key}:${t}`))

    for (const t of thresholds) {
      if (value < t) fired.delete(`${key}:${t}`)
    }
    for (const t of crossed) fired.add(`${key}:${t}`)

    if (crossed.length > 0) $.ui.toast(`${LABELS[key]} usage at ${Math.round(value)}%`)
  }

  await update($, alerted, () => [...fired])
}

// Rereads the settings /effort and /advisor write, and moves the countdown
// on; the band redraws only when one of them reads differently.
async function refresh($: EngineInterface) {
  const [stored, figures, time, shown, left] = await Promise.all([
    $.settings.read(),
    read($, usage),
    $.clock.now(),
    read($, settings),
    read($, countdown),
  ])
  const chosen = { effort: asText(stored.effortLevel), advisor: asText(stored.advisorModel) }
  const resetsAt = figures?.fiveHour?.resetsAt
  const remaining = resetsAt ? formatRemaining(resetsAt - time) : ''

  if (!same(shown, chosen)) await update($, settings, () => chosen)
  if (remaining !== left) await update($, countdown, () => remaining)
}

export const register: Register = (on, options) => {
  const warnAt = Number(options.warnAt)
  const thresholds = [warnAt, Number(options.criticalAt)]

  on('session.start', async ($, e, next) => {
    const [measured, model] = await Promise.all([$.session.usage(), $.session.model()])
    const figures = toUsage(measured)

    await update($, usage, () => figures)
    await update($, request, r => ({ ...r, model: r.model ?? model }))
    await refresh($)
    await alert($, figures, thresholds)

    $.clock.every(10_000, () => refresh($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const figures = toUsage(e)

    await update($, usage, () => figures)
    await refresh($)
    await alert($, figures, thresholds)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      const carried = { model: e.model, effort }
      if (!same(await read($, request), carried)) await update($, request, () => carried)
    }

    return yield* next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [figures, last, chosen, remaining] = await Promise.all([
      read($, usage),
      read($, request),
      read($, settings),
      read($, countdown),
    ])

    if (e.props.hasSurvey || (figures === null && last.model === undefined)) {
      return next(e)
    }

    // `muted` follows `text` in the theme's grey: a value that is only a default.
    const parts: { key: string; text: string; muted?: string; color?: string; bold?: boolean }[] = []

    for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
      const value = figures ? percentOf(figures, key) : undefined
      if (value === undefined) continue

      const rounded = Math.round(value)
      const suffix = key === 'fiveHour' && remaining ? ` (${remaining})` : ''
      const isHot = rounded >= warnAt

      parts.push({
        key,
        text: `${LABELS[key]} ${rounded}%${suffix}`,
        color: isHot ? RED : undefined,
        bold: isHot,
      })
    }

    const effort = chosen.effort ?? last.effort
    if (last.model) parts.push({ key: 'model', text: prettyModel(last.model), color: YELLOW })
    if (effort) {
      const color = effort in EFFORT_COLORS ? EFFORT_COLORS[effort] : WHITE
      parts.push({ key: 'effort', text: effort, color })
    }
    parts.push(
      chosen.advisor
        ? { key: 'advisor', text: `Advisor: ${prettyModel(chosen.advisor)}`, color: WHITE }
        : { key: 'advisor', text: 'Advisor: ', muted: 'off', color: WHITE },
    )

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="usage-line" justifyContent="flex-end" flexGrow={1}>
        {parts.map((part, i) => (
          <Text key={part.key} wrap="truncate">
            {i > 0 ? <Text dimColor> | </Text> : null}
            <Text color={part.color} dimColor={part.color === undefined} bold={part.bold}>
              {part.text}
            </Text>
            {part.muted ? <Text dimColor>{part.muted}</Text> : null}
          </Text>
        ))}
      </Box>
    )
  })
}
