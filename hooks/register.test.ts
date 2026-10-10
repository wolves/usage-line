import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface, SessionMeasureInput } from 'claude-code'

import { formatRemaining, prettyModel } from './register'

const HOUR = 3_600_000

const measure = (fiveHour: number, week: number, context: number): SessionMeasureInput => ({
  context: { window: 200_000, percent: context },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(3.5 * HOUR).toISOString() },
    { kind: 'seven_day', percentUsed: week },
  ],
  changed: ['context', 'rateLimits'],
})

// Stands in for the engine beneath the plugin; returns the toasts it was handed.
const engine = (on: On, settings: Record<string, unknown> = {}) => {
  const toasts: string[] = []
  on('settings.read', () => ({ value: settings }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return toasts
}

const submit = ($: Engine) => $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })

const step = async ($: Engine, effort?: 'low' | 'high') => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 })) {
    // drain the step
  }
}

// The band's text as one surface draws it.
const band = async ($: Engine, surface: RenderSurface = 'terminal') => {
  const ui = await $.ui.mount({
    plugin: 'usage-line',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  })
  const text = (await ui.find({ key: 'usage-line' }))?.text ?? ''
  await ui.unmount()
  return text
}

test('formats model ids and countdowns', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 [1m]')
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(prettyModel('gpt-x')).toBe('gpt-x')
  expect(formatRemaining(2 * HOUR + 5 * 60_000)).toBe('2h 5m')
  expect(formatRemaining(-1)).toBe('0h 0m')
})

test('draws usage, model, effort and advisor', async ($, on) => {
  mock.clock(on, { now: HOUR })
  engine(on, { effortLevel: 'high', advisorModel: 'claude-fable-5-1' })
  await $.session.measure(measure(42, 12, 85))
  await submit($)
  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await band($, surface)).toBe('5h 42% (2h 30m) | wk 12% | ctx 85% | Opus 5.5 | high | Advisor: Fable 5.1')
  }
})

test('effort comes from settings, else from the last request', async ($, on) => {
  mock.clock(on, { now: HOUR })
  const settings: Record<string, unknown> = {}
  engine(on, settings)
  await submit($)
  await step($, 'low')
  expect(await band($)).toContain('| low | Advisor: off')

  settings.effortLevel = 'max'
  await submit($)
  expect(await band($)).toContain('| max |')
})

test('toasts once per threshold and again after a reset', async ($, on) => {
  mock.clock(on, { now: 0 })
  const seen = engine(on)

  await $.session.measure(measure(50, 10, 20))
  expect(seen).toEqual([])

  await $.session.measure(measure(81, 10, 20))
  await $.session.measure(measure(83, 10, 20))
  expect(seen).toEqual(['5h usage at 81%'])

  // ctx jumps past both thresholds at once: one toast, not two.
  await $.session.measure(measure(96, 10, 97))
  expect(seen).toEqual(['5h usage at 81%', '5h usage at 96%', 'ctx usage at 97%'])

  await $.session.measure(measure(2, 10, 20))
  await $.session.measure(measure(85, 10, 20))
  expect(seen.at(-1)).toBe('5h usage at 85%')
})

test('the timer redraws only when the countdown or a setting changes', async ($, on) => {
  // 2h 30m 30s before the reset: the drawn minute rolls over 40s in.
  const clock = mock.clock(on, { now: HOUR - 30_000 })
  const settings: Record<string, unknown> = { effortLevel: 'high' }
  engine(on, settings)
  on('session.usage', () => ({ value: { startedAt: 0, ...measure(42, 12, 20) } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  const writes: string[] = []
  on('state.set', ($, e, next) => {
    writes.push(e.key)
    return next(e)
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await band($)).toContain('5h 42% (2h 30m)')

  writes.length = 0
  await clock.advance(30_000)
  expect(writes).toEqual([])

  await clock.advance(30_000)
  expect(writes).toEqual(['countdown'])
  expect(await band($)).toContain('5h 42% (2h 29m)')

  writes.length = 0
  settings.effortLevel = 'max'
  await clock.advance(10_000)
  expect(writes).toEqual(['settings'])
})
