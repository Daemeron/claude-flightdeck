import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  DEFAULT_ARCHITECT,
  DEFAULT_GATE,
  DEFAULT_TURN,
  afterCall,
  applyStep,
  consultTimeline,
  describeInput,
  endConsult,
  fitLegend,
  fmtResetIn,
  fmtSpeed,
  gateSummary,
  lanes,
  limitLabel,
  limitOf,
  gateRows,
  logRows,
  LOG_LINES,
  wrapRows,
  MINI_ROWS,
  miniLog,
  momentOf,
  normalizeCard,
  normalizeGate,
  normalizeLog,
  titleLines,
  parseConfig,
  prettyModel,
  promptLine,
  handbackOf,
  adviceLine,
  receiptOf,
  recordCheck,
  redact,
  settleCheck,
  trimRecent,
  startConsult,
  stepSpeed,
} from '../hooks/core'
import type { Check } from '../types'

// ---------------------------------------------------------------- pure behaviour

test('redaction masks credentials before anything is stored', () => {
  expect(redact('curl -H "Authorization: Bearer abc.def.ghi123" x')).not.toContain('abc.def')
  expect(redact('export OPENAI_API_KEY=sk-proj-1234567890abcdef')).not.toContain('1234567890')
  expect(redact('gh auth --token ghp_abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
  expect(redact('psql postgres://bob:hunter2@db/x')).not.toContain('hunter2')
  expect(redact('password=hunter2 ls')).not.toContain('hunter2')
  expect(redact('ls -la src/')).toBe('ls -la src/')
  expect(describeInput('Read', { file_path: 'C:\\Users\\me\\proj\\src\\main.ts' })).toBe('Read → src/main.ts')
})

const check = (id: string, verdict: Check['verdict'], bucket: Check['bucket'] = 'shell'): Check => ({
  id,
  tool: 'Bash',
  bucket,
  verdict,
  inSubagent: false,
  detail: 'Bash → ls',
  at: 1,
})

test('an ask is settled by the call that follows: cleared if it ran, deny if refused', () => {
  let g = recordCheck(DEFAULT_GATE, check('a', 'ask'))
  g = recordCheck(g, check('b', 'ask'))
  g = recordCheck(g, check('c', 'rule', 'file'))
  g = settleCheck(g, 'a', true)
  g = settleCheck(g, 'b', false)
  g = settleCheck(g, 'zzz', true) // not an ask: unchanged
  const s = gateSummary(g)
  expect([s.rule, s.ask, s.cleared, s.deny, s.total]).toEqual([1, 0, 1, 1, 3])
  expect(g.recent.map(c => c.verdict)).toEqual(['cleared', 'deny', 'rule'])
})

test('the gate tallies a mixed run of verdicts per family', () => {
  let g = DEFAULT_GATE
  g = recordCheck(g, check('r1', 'rule', 'file'))
  g = recordCheck(g, check('a1', 'ask', 'shell'))
  g = recordCheck(g, check('a2', 'ask', 'shell'))
  g = recordCheck(g, check('d1', 'deny', 'other'))
  g = settleCheck(g, 'a1', true)
  g = settleCheck(g, 'a2', false)
  expect(g.totals.file).toEqual({ rule: 1, ask: 0, cleared: 0, deny: 0 })
  expect(g.totals.shell).toEqual({ rule: 0, ask: 0, cleared: 1, deny: 1 })
  expect(g.totals.other.deny).toBe(1)
  expect(gateSummary(g)).toEqual({ rule: 1, ask: 0, cleared: 1, deny: 2, total: 4 })
  expect(gateSummary(DEFAULT_GATE).total).toBe(0)
})

test('a v1-shaped gate reads as empty, then records normally', () => {
  const g = normalizeGate({ file: { allow: 3, ask: 1, deny: 0, cleared: 2 }, shell: null })
  expect(gateSummary(g).total).toBe(0)
  const next = recordCheck(g, check('n1', 'rule', 'file'))
  expect(next.totals.file.rule).toBe(1)
  expect(next.recent.length).toBe(1)
})

test('a pending ask is never trimmed out before it settles', () => {
  let g = recordCheck(DEFAULT_GATE, check('old-ask', 'ask'))
  for (let i = 0; i < 120; i += 1) g = recordCheck(g, check(`r${i}`, 'rule', 'file'))
  expect(g.recent.length).toBe(80)
  expect(g.recent.some(c => c.id === 'old-ask')).toBe(true)
  g = settleCheck(g, 'old-ask', true)
  expect(gateSummary(g).ask).toBe(0)
  expect(trimRecent([check('a', 'rule'), check('b', 'rule')], 5).length).toBe(2)
})

test('edits count from every loop; errors only from the main loop', () => {
  const t = { ...DEFAULT_TURN, errorStreak: 1 }
  expect(afterCall(t, { inSubagent: true, hasFailed: false, isEdit: true }).edits).toBe(1)
  expect(afterCall(t, { inSubagent: true, hasFailed: true, isEdit: false }).errorStreak).toBe(1)
  expect(afterCall(t, { inSubagent: false, hasFailed: true, isEdit: false })).toEqual({ ...t, errorStreak: 2, errors: 1 })
  expect(momentOf(afterCall(DEFAULT_TURN, { inSubagent: true, hasFailed: false, isEdit: true }))).toBe('before done')
  expect(momentOf({ edits: 0, errorStreak: 2 })).toBe('error repeats')
})

test("a card's context is its latest step's whole input; output adds up", () => {
  let c = normalizeCard({ id: 'x' })
  c = applyStep(c, { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000, output_tokens: 500 }, stopReason: 'tool_use' })
  c = applyStep(c, { model: 'claude-sonnet-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 40_000, output_tokens: 700 }, stopReason: 'max_tokens' })
  expect([c.ctx, c.out, c.steps, c.lastStop, c.model]).toEqual([40_005, 1200, 2, 'max_tokens', 'claude-sonnet-5-5'])
})

test('consults open, close by id, and draw on a shared timeline', () => {
  let a = startConsult(DEFAULT_ARCHITECT, { id: 's1', at: 0, moment: 'before a plan', via: 'advisor tool' })
  a = startConsult(a, { id: 's1', at: 5, moment: 'before a plan', via: 'again' }) // same id: ignored
  a = endConsult(a, 10, null, 's1')
  a = startConsult(a, { id: 's2', at: 90, moment: 'before done', via: 'advisor tool' })
  expect(a.consults.length).toBe(2)
  expect(a.consults[0]?.endAt).toBe(10)
  const tl = consultTimeline(a, 100, 11)
  expect(tl.length).toBe(11)
  expect(tl.startsWith('◆━')).toBe(true)
  expect(tl.split('◆').length - 1).toBe(2)
})

test('config is read leniently: bad values fall back to defaults', () => {
  const d = parseConfig({})
  expect([d.miniFill, d.dockFill, parseConfig({ dockFill: false }).dockFill, parseConfig({ dockFill: 'no' }).dockFill]).toEqual([true, true, false, true])
  expect([d.maxCards, d.layout, d.motion, d.moments, d.panels.length]).toEqual([3, 'auto', true, true, 7])
  expect(d.architect.test('fable-advisor:fable-advisor')).toBe(true)
  const c = parseConfig({ architectPattern: '([', maxCards: 99, layout: 'diagonal', panels: 'log, gate ,nope,gate', motion: 'off' })
  expect(c.architect.test('advisor')).toBe(true) // invalid regex → default
  expect([c.maxCards, c.layout, c.motion]).toEqual([6, 'auto', false])
  expect(c.panels).toEqual(['log', 'gate'])
})

test('state saved under an older shape still reads', () => {
  expect(normalizeLog([{ at: '08:00:00', who: 'jev', text: 'x' }])[0]).toEqual({ at: 0, who: 'jev', text: 'x', agentId: null, kind: 'info' })
  const g = normalizeGate({ file: { allow: 1 } }) // v1 gate shape
  expect(g.recent).toEqual([])
  expect(g.totals.shell.rule).toBe(0)
  expect(normalizeCard({ id: 'a', status: 'done' }).tools).toEqual([])
})

test('layout math: lanes share one axis, the log gets 4-8 rows, the legend never wraps', () => {
  const cards = [
    { ...normalizeCard({}), id: 'a', spawnedAt: 1000, endedAt: 1050 },
    { ...normalizeCard({}), id: 'b', spawnedAt: 1050, endedAt: null },
  ]
  const [a, b] = lanes(cards, 1100, 20)
  expect(a).toEqual({ id: 'a', before: 0, bar: 10, after: 10 })
  expect(b?.before).toBe(10)
  expect((b?.before ?? 0) + (b?.bar ?? 0) + (b?.after ?? 0)).toBe(20)
  expect([logRows(10, 40), logRows(50, 40), logRows(200, 40)]).toEqual([4, 7, 8])
  expect(fitLegend([{ label: 'main' }, { label: 'agents' }, { label: 'architect' }], 20).map(x => x.label)).toEqual(['main', 'agents'])
  expect(limitLabel('five_hour')).toBe('5h')
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M')
  expect(prettyModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Sonnet 4.5')
  expect(prettyModel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
  expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4')
  expect(prettyModel('claude-3-opus-20240229')).toBe('Opus 3')
  expect(prettyModel('z-ai/glm-5.3-flash-with-a-long-name')).toBe('z-ai/glm-5.3-flash-wi…')
  expect(prettyModel('')).toBe('—')
  expect(promptLine('fix the parser')).toEqual({ who: 'you', text: 'fix the parser' })
  const hb = '<agent-message from="a1940a83d593229d5">\n[Subagent hand-back] The text below is the final report. The report follows:\n  Add gate tests: redaction edge cases.\n  - more\n</agent-message>'
  expect(handbackOf(hb)).toEqual({ from: 'a1940a83d593229d5', body: 'Add gate tests: redaction edge cases.' })
  expect(handbackOf('<agent-message from="x">\nPlain report line\n</agent-message>')).toEqual({ from: 'x', body: 'Plain report line' })
  expect(handbackOf('fix the parser')).toBe(null)
  expect(adviceLine('## Ship it after one more gate test.\n- details')).toBe('Ship it after one more gate test.')
  expect(adviceLine('[Subagent hand-back] header\n\n**Fix card overflow first**')).toBe('Fix card overflow first')
  expect(adviceLine('')).toBe('')
  expect(promptLine('<agent-message from="a1492260715f3be7b"> [Subagent hand-back]')).toEqual({ who: 'engine', text: 'agent message from a1492260' })
  expect(receiptOf({ ...DEFAULT_TURN, costAtStart: 5 }, { durationMs: 1, agentsSince: 0, costNow: 5, reason: 'answer' }).costDelta).toBe(null)
  expect(titleLines('Write tinyqueue test suite', 13, 16)).toEqual(['Write', 'tinyqueue test…'])
  expect(titleLines('Short', 13, 16)).toEqual(['Short', ''])
  expect(receiptOf({ ...DEFAULT_TURN, costAtStart: 1, edits: 2 }, { durationMs: 1000, agentsSince: 3, costNow: 1.5, reason: 'answer' }).costDelta).toBe(0.5)
})

test('a request\'s speed: time to its first piece, then output tokens per second to the stop', () => {
  expect(stepSpeed(1000, 1800, 3800, 120)).toEqual({ ttftMs: 800, tokPerS: 60 })
  expect(stepSpeed(1000, null, 3800, 120)).toBe(null) // no response arrived
  expect(stepSpeed(1000, 1800, 1800, 120)?.tokPerS).toBe(null) // nothing to divide by
  expect(stepSpeed(1000, 1800, 3800, null)?.tokPerS).toBe(null)
  expect(fmtSpeed({ ttftMs: 800, tokPerS: 60.4 })).toBe('ttft 0.8s · 60 tok/s')
  expect(fmtSpeed({ ttftMs: 1250, tokPerS: null })).toBe('ttft 1.3s')
})

test('a window keeps its reset time, drawn as the time left', () => {
  expect(limitOf({ kind: 'five_hour', percentUsed: 19, resetsAt: '1970-01-01T03:10:00.000Z' })).toEqual({ kind: 'five_hour', pct: 19, resetsAt: 11_400_000 })
  expect(limitOf({ kind: 'seven_day', percentUsed: 3 }).resetsAt).toBe(null)
  expect(limitOf({ kind: 'spend_limit', percentUsed: 1, resetsAt: 'soon' }).resetsAt).toBe(null)
  expect([fmtResetIn(11_400_000, 0), fmtResetIn(25 * 60_000 + 5_000, 0), fmtResetIn(4 * 86_400_000 + 2 * 3_600_000, 0)]).toEqual(['3h10m', '25m', '4d2h'])
  expect([fmtResetIn(null, 0), fmtResetIn(undefined, 0), fmtResetIn(5, 10)]).toEqual(['', '', ''])
})

// ---------------------------------------------------------------- drawing

const engine = (on: On) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return clock
}

const pane = (bodyColumns: number, bodyRows = 70) => ({
  plugin: 'flightdeck',
  component: 'Pane' as const,
  requestId: 'flightdeck',
  props: {
    title: 'Flightdeck',
    isFocused: true,
    bodyColumns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows },
    view: {},
  },
})

let spawnN = 0
const spawn = (subagentType: string, description: string) => ({
  prompt: description,
  description,
  subagentType,
  tool_use_id: `tu${++spawnN}`,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})

test('a fresh session draws on every surface and width, empty panels hidden', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const cols of [40, 60, 86, 120]) {
      const ui = await $.ui.mount({ ...pane(cols), surface })
      expect(await ui.find({ text: /· main$/ })).toBeDefined()
      expect(await ui.find({ text: /session log/ })).toBeDefined()
      expect(await ui.find({ text: /agents ·/ })).toBeUndefined() // no subagents: no agents panel
      expect(await ui.find({ text: /permissions/ })).toBeUndefined() // no checks yet: no gate panel
      await ui.unmount()
    }
  }
})

test('inline above the prompt, the pane is a summary of at most 8 rows', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `m${++n}` }))
  on('tool.check', () => ({ decision: 'allow' }))
  await $.turn.start({ text: 'go', turnId: 'M1' })
  for (const d of ['one', 'two', 'three', 'four', 'five']) await $.agent.spawn(spawn('general-purpose', `task ${d}`))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'm-k1' })
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...pane(80), props: { ...pane(80).props, placement: 'inline' as const }, surface })
    const root = (await ui.drawn()) as { children?: unknown[] }
    expect((root.children ?? []).filter(Boolean).length <= 8).toBe(true)
    expect(await ui.find({ text: /\+2 more agents/ })).toBeDefined()
    expect(await ui.find({ text: /1 allowed/ })).toBeDefined()
    expect(await ui.find({ text: /session log/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('/clear starts the pane fresh', async ($, on) => {
  engine(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'c1' }))
  await $.turn.start({ text: 'go', turnId: 'C1' })
  await $.agent.spawn(spawn('Explore', 'look around'))
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /look around/ })).toBeUndefined()
  await ui.unmount()
})

test('colours come from the theme by default, raw hex only when asked', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  const title = await ui.find({ text: /· main$/ })
  expect(title?.props.color).toBe('claude')
  await ui.unmount()
})

test('pastel keeps the fixed dark-terminal colours', { options: { palette: 'pastel' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect((await ui.find({ text: /· main$/ }))?.props.color).toBe('#7dd3fc')
  await ui.unmount()
})

test('subagents become cards, then swimlanes past the card limit; a card expands on its hotkey', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `ag${++n}` }))
  await $.turn.start({ text: 'fan out', turnId: 'T1' })
  await $.agent.spawn(spawn('general-purpose', 'Write the parser tests'))
  await $.agent.spawn(spawn('Explore', 'Map the call sites'))

  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /Write the parser/ })).toBeDefined()
  expect(await ui.find({ text: /Sonnet 5\.5/ })).toBeDefined() // differs from main: shown
  await ui.press({ key: 'card-ag1' })
  expect(await ui.find({ text: /^Write the parser tests$/ })).toBeDefined() // the expanded panel, full title
  await ui.unmount()

  await $.agent.spawn(spawn('general-purpose', 'Implement the parser'))
  await $.agent.spawn(spawn('general-purpose', 'Review the parser'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const lanesUi = await $.ui.mount({ ...pane(64), surface })
    expect(await lanesUi.find({ text: /4 total/ })).toBeDefined()
    expect(await lanesUi.find({ text: /━/ })).toBeDefined()
    await lanesUi.unmount()
  }
})

test('the server-side advisor is read from assistant rows: consulting, then on call', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'plan it', turnId: 'T2' })
  const row = (content: unknown[]) =>
    $.session
      .append({
        message: { type: 'assistant', role: 'assistant', content: content as never },
        door: 'response',
        origin: { kind: 'model', model: 'claude-opus-5-5' } as never,
        uuid: `u${++spawnN}`,
      })
      .catch(() => undefined) // the test has no transcript to store rows in
  await row([{ type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} }])
  const mid = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await mid.find({ text: /ARCHITECT · advising/ })).toBeDefined()
  expect(await mid.find({ text: /◆ before a plan/ })).toBeDefined()
  await mid.unmount()

  await row([{ type: 'advisor_tool_result', tool_use_id: 'srv1', content: { type: 'advisor_redacted_result' } }])
  const after = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await after.find({ text: /ARCHITECT · on call/ })).toBeDefined()
  expect(await after.find({ text: /^1$/ })).toBeDefined()
  await after.unmount()
})

test('the gate strip fills from checks and a row opens its redacted drill-down', async ($, on) => {
  engine(on)
  on('tool.check', (_$, e) => ({ decision: e.tool === 'Read' ? 'allow' : 'ask' }))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a/b.ts' }, tool_use_id: 'k1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefgh12345" api' }, tool_use_id: 'k2' })
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /2 checks/ })).toBeDefined()
  expect(await ui.find({ text: /1 pending/ })).toBeDefined()
  await ui.press({ key: 'gate-shell' })
  expect(await ui.find({ text: /Authorization: Bearer •••/ })).toBeDefined()
  expect(await ui.find({ text: /abcdefgh12345/ })).toBeUndefined()
  await ui.unmount()
})

test('config changes labels, hides panels and turns the moments off', { options: { architectLabel: 'REVIEWER', panels: 'main,architect,agents,log', moments: false } }, async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: `r${++n}` }))
  await $.turn.start({ text: 'review it', turnId: 'T3' })
  await $.agent.spawn(spawn('fable-advisor:fable-advisor', 'final review'))
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /REVIEWER · advising/ })).toBeDefined()
  expect(await ui.find({ text: /permissions/ })).toBeUndefined()
  expect(await ui.find({ text: /before a plan/ })).toBeUndefined()
  await ui.unmount()
})

test('a consult whose start and result share one row closes, and its review flag with it', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.turn.start({ text: 'go', turnId: 'T4' })
  // An edit first, so the consult is inferred as "before done" and sets the review flag.
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b' } as never)
  await $.session
    .append({
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srv9', name: 'advisor', input: {} },
          { type: 'advisor_tool_result', tool_use_id: 'srv9', content: { type: 'advisor_redacted_result' } },
        ] as never,
      },
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' } as never,
      uuid: 'one-row',
    })
    .catch(() => undefined)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /ARCHITECT · on call/ })).toBeDefined()
  expect(await ui.find({ text: /◆ before done/ })).toBeDefined()
  expect(await ui.find({ text: /reviewing before done/ })).toBeUndefined()
  await ui.unmount()
})

test('with no architect anywhere, the panel, legend entry and status field stay hidden', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /ARCHITECT/ })).toBeUndefined()
  expect(await ui.find({ text: /^ architect$/ })).toBeUndefined()
  await ui.unmount()
})

test('cards that cannot fit the pane fall back to lanes', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `w${++n}` }))
  await $.turn.start({ text: 'go', turnId: 'W1' })
  for (const d of ['alpha', 'beta', 'gamma']) await $.agent.spawn(spawn('Explore', `task ${d}`))
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await narrow.find({ text: /━/ })).toBeDefined() // lanes
  await narrow.unmount()
  const wide = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await wide.find({ text: /━/ })).toBeUndefined() // three cards fit in 70
  expect(await wide.find({ text: /task gamma/ })).toBeDefined()
  await wide.unmount()
})

test("a background architect's advice is read from its hand-back", async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'fab1' }))
  await $.turn.start({ text: 'review it', turnId: 'H1' })
  await $.agent.spawn(spawn('fable-advisor:fable-advisor', 'final review'))
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'H1', agentId: 'fab1', reason: 'answer' })
  await $.turn.start({
    text: '<agent-message from="fab1">\n[Subagent hand-back] The report follows:\n  Ship it after one more gate test.\n</agent-message>',
    turnId: 'H2',
  })
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /» Ship it after one more gate test\./ })).toBeDefined()
  await ui.unmount()
})

test('each rate-limit window shows the time to its reset where the main panel has room', async ($, on) => {
  engine(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const at = (ms: number) => new Date(ms).toISOString()
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 19, resetsAt: at(3 * 3_600_000 + 10 * 60_000) },
      { kind: 'seven_day', percentUsed: 3, resetsAt: at(4 * 86_400_000 + 2 * 3_600_000) },
    ],
    changed: ['rateLimits'],
  })
  for (const cols of [64, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    expect(await ui.find({ text: /19% ↻3h10m/ })).toBeDefined()
    expect(await ui.find({ text: /3% ↻4d2h/ })).toBeDefined()
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await narrow.find({ text: /19%/ })).toBeDefined()
  expect(await narrow.find({ text: /↻/ })).toBeUndefined() // no room: the gauges stay whole
  await narrow.unmount()
})

test("the main box shows the last request's time to first token and decode speed", async ($, on) => {
  const clock = engine(on)
  // The model beneath: 800 ms to its first words, then 2 s more to stop after 120 tokens.
  on('turn.step', async function* () {
    await clock.sleep(800)
    yield { kind: 'text' as const, index: 0, text: 'hello' }
    await clock.sleep(2000)
    const usage = { input_tokens: 10, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: 'S1', index: 0, answer: 'hello', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  const before = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await before.find({ text: /ttft/ })).toBeUndefined() // nothing measured yet: no line
  await before.unmount()
  const s = $.turn.step({ turnId: 'S1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const first = s.next()
  await clock.advance(800)
  expect((await first).value).toEqual({ kind: 'text', index: 0, text: 'hello' })
  const stop = s.next()
  await clock.advance(2000)
  await stop
  for await (const _ of s) void _
  await s.result
  for (const cols of [40, 64, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    expect(await ui.find({ text: /ttft 0\.8s · 60 tok\/s/ })).toBeDefined()
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- inline fill

const inline = (cols = 80) => ({ ...pane(cols), props: { ...pane(cols).props, placement: 'inline' as const }, surface: 'terminal' as const })

/** The mini layout's rows: the root's children, arrays flattened, nulls dropped. */
const rowsOf = async (ui: { drawn: () => Promise<unknown> }) => {
  const root = (await ui.drawn()) as { children?: unknown[] }
  return (root.children ?? []).flat(Infinity).filter(Boolean).length
}

const idleWithPrompts = async ($: Parameters<TestBody>[0], n: number) => {
  for (let i = 1; i <= n; i += 1) {
    await $.turn.start({ text: `prompt ${i}`, turnId: `P${i}` })
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: `P${i}`, reason: 'answer' })
  }
}

test('the row budget fills with the newest log lines and never passes 8', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ agentId: i % 2 ? 'a1' : null, i }))
  expect(MINI_ROWS).toBe(8)
  expect(miniLog(lines, 2).map(l => l.i)).toEqual([4, 5, 6, 7, 8, 9])
  expect(miniLog(lines, 8)).toEqual([])
  expect(miniLog(lines, 9)).toEqual([])
  expect(miniLog(lines, 5, 'a1').map(l => l.i)).toEqual([5, 7, 9])
  expect(miniLog([], 1)).toEqual([])
})

test('an idle inline session fills its spare rows with the recent log', async ($, on) => {
  engine(on)
  await idleWithPrompts($, 10)
  const ui = await $.ui.mount(inline())
  expect(await rowsOf(ui)).toBe(8)
  expect(await ui.find({ text: /last turn/ })).toBeDefined()
  // vitals + last turn leave 6 rows: prompts 5-10, newest last
  expect(await ui.find({ text: /^prompt 4$/ })).toBeUndefined()
  for (const i of [5, 6, 7, 8, 9, 10]) expect(await ui.find({ text: new RegExp(`^prompt ${i}$`) })).toBeDefined()
  expect(await ui.find({ text: /^you $/ })).toBeDefined()
  await ui.unmount()
})

test('an empty log adds no rows to the inline summary', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(inline())
  expect(await rowsOf(ui)).toBe(1)
  await ui.unmount()
})

test('a busy inline session keeps the old rows and leaves no room for the log', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `b${++n}` }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('turn.step', async function* (_$, e) {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model }
    return { turnId: e.turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  await $.turn.start({ text: 'go', turnId: 'B1' })
  for (const d of ['one', 'two', 'three', 'four', 'five']) await $.agent.spawn(spawn('general-purpose', `task ${d}`))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'b-k1' })
  for await (const _ of $.turn.step({ turnId: 'B1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'loop1' })) void _
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'B1', reason: 'answer' })
  const ui = await $.ui.mount(inline())
  expect(await rowsOf(ui)).toBe(8)
  expect(await ui.find({ text: /\+2 more agents/ })).toBeDefined()
  expect(await ui.find({ text: /other loops 1/ })).toBeDefined()
  expect(await ui.find({ text: /last turn/ })).toBeDefined()
  expect(await ui.find({ text: /spawned/ })).toBeUndefined()
  expect(await ui.find({ text: /^go$/ })).toBeUndefined()
  await ui.unmount()
})

test('miniFill off restores the compact inline summary', { options: { miniFill: false } }, async ($, on) => {
  engine(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await idleWithPrompts($, 10)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 19 }], changed: ['rateLimits'] })
  const ui = await $.ui.mount(inline())
  expect(await rowsOf(ui)).toBe(2)
  expect(await ui.find({ text: /prompt/ })).toBeUndefined()
  expect(await ui.find({ text: /5h/ })).toBeUndefined()
  await ui.unmount()
})

test('the inline vitals add effort, mode, requests and rate limits only once they are known', async ($, on) => {
  engine(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'v1' }))
  on('turn.step', async function* (_$, e) {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model }
    return { turnId: e.turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  const before = await $.ui.mount(inline())
  for (const re of [/effort/, /mode/, /req/, /5h/]) expect(await before.find({ text: re })).toBeUndefined()
  await before.unmount()
  for await (const _ of $.turn.step({ turnId: 'V1', index: 0, model: 'claude-opus-5-5', messageCount: 1, effort: 'high' })) void _
  await $.agent.spawn({ ...spawn('Explore', 'look'), permissionMode: 'auto' })
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 19 },
      { kind: 'seven_day', percentUsed: 3 },
      { kind: 'spend_limit', percentUsed: 50 },
    ],
    changed: ['rateLimits'],
  })
  const after = await $.ui.mount(inline(200))
  expect(await after.find({ text: / · effort high/ })).toBeDefined()
  expect(await after.find({ text: / · mode auto/ })).toBeDefined()
  expect(await after.find({ text: / · 1 req/ })).toBeDefined()
  expect(await after.find({ text: / · 5h / })).toBeDefined()
  expect(await after.find({ text: / · 7d / })).toBeDefined()
  expect(await after.find({ text: /spend/ })).toBeUndefined() // the first two windows only
  await after.unmount()
})

// ---------------------------------------------------------------- docked fill

test('the docked log takes 4-8 rows, or with dockFill every row the panels leave up to all it keeps', () => {
  // Off: the old rule, unchanged.
  expect([logRows(10, 40, false), logRows(50, 40, false), logRows(200, 40, false), logRows(70, 20, false)]).toEqual([4, 7, 8, 8])
  // On: the same floor, then whatever is left, up to the lines the pane keeps.
  expect([logRows(10, 40, true), logRows(50, 40, true), logRows(70, 20, true), logRows(200, 40, true)]).toEqual([4, 7, 47, LOG_LINES])
  expect(LOG_LINES).toBe(60)
  expect([wrapRows('', 10), wrapRows('short', 10), wrapRows('one two three', 7), wrapRows('abcdefghijklmnopqrstuvwxyz', 10), wrapRows('a\nb', 10)]).toEqual([1, 1, 2, 3, 2])
})

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const kids = (el: Drawn) => (el.children ?? []).flat(Infinity).filter(c => c !== null && c !== undefined && c !== false)
const textOf = (x: unknown): string =>
  typeof x === 'string' || typeof x === 'number' ? String(x) : x && typeof x === 'object' ? String((x as Drawn).props?.label ?? '') + kids(x as Drawn).map(textOf).join('') : ''
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

/** Rows a drawn tree takes at `w` columns, laid out as the terminal lays out the elements this pane uses. */
const rowsAt = (x: unknown, w: number): number => {
  if (!x || typeof x !== 'object') return 1
  const el = x as Drawn
  const p = el.props ?? {}
  if (el.type === 'Text') return p.wrap === 'wrap' ? wrapRows(textOf(el), w) : 1
  if (el.type !== 'Box') return Math.max(1, num(p.height))
  const frame = p.borderStyle ? 2 : 0
  const inner = (typeof p.width === 'number' ? p.width : w) - frame - 2 * num(p.paddingX)
  const cs = kids(el)
  let body = 0
  if (p.flexDirection === 'column') body = cs.reduce<number>((n, c) => n + rowsAt(c, inner), 0)
  else if (p.flexWrap === 'wrap') {
    let col = 0
    body = cs.length > 0 ? 1 : 0
    for (const c of cs) {
      const cw = textOf(c).length
      if (col > 0 && col + num(p.columnGap) + cw > inner) {
        body += 1
        col = 0
      }
      col += (col > 0 ? num(p.columnGap) : 0) + cw
    }
  } else body = Math.max(0, ...cs.map(c => rowsAt(c, inner)))
  return frame + 2 * num(p.paddingY) + num(p.marginTop) + num(p.marginBottom) + body
}

/** The lines the docked log draws: its panel's rows below the `session log` title. */
const logLinesOf = (x: unknown): number => {
  if (!x || typeof x !== 'object') return -1
  const cs = kids(x as Drawn)
  if ((x as Drawn).type === 'Box' && textOf(cs[0]) === 'session log') return cs.length - 1
  return Math.max(-1, ...cs.map(logLinesOf))
}

/** How many of `prompt 1`..`prompt n` the docked log shows. */
const promptsShown = async (ui: { find: (q: { text: RegExp }) => Promise<unknown> }, n: number) => {
  let shown = 0
  for (let i = 1; i <= n; i += 1) if (await ui.find({ text: new RegExp(`^prompt ${i}$`) })) shown += 1
  return shown
}

test('a tall docked pane fills with the session log', async ($, on) => {
  engine(on)
  await idleWithPrompts($, 40)
  const ui = await $.ui.mount({ ...pane(58, 70), surface: 'terminal' })
  const shown = await promptsShown(ui, 40)
  expect(shown > 30).toBe(true)
  expect(await ui.find({ text: /^prompt 40$/ })).toBeDefined() // the newest line is never the one cut
  expect(rowsAt(await ui.drawn(), 58) <= 70).toBe(true)
  await ui.unmount()
})

test('dockFill off keeps the docked log at 8 lines', { options: { dockFill: false } }, async ($, on) => {
  engine(on)
  await idleWithPrompts($, 40)
  const ui = await $.ui.mount({ ...pane(58, 70), surface: 'terminal' })
  expect(await promptsShown(ui, 40)).toBe(8)
  expect(await ui.find({ text: /^prompt 33$/ })).toBeDefined()
  expect(await ui.find({ text: /^prompt 32$/ })).toBeUndefined()
  await ui.unmount()
})

/** At each size: the log grows only into free rows (at its floor of 4 there is nothing to give back), and leaves a few spare at most. */
const fillsWithoutOverflow = async ($: Parameters<TestBody>[0], sizes: [number, number][]) => {
  for (const [cols, rows] of sizes) {
    const ui = await $.ui.mount({ ...pane(cols, rows), surface: 'terminal' })
    const tree = await ui.drawn()
    const drawn = rowsAt(tree, cols)
    const lines = logLinesOf(tree)
    if (lines > 4) expect({ cols, rows, drawn: drawn <= rows }).toEqual({ cols, rows, drawn: true })
    if (lines > 4 && lines < LOG_LINES) expect({ cols, rows, spare: rows - drawn <= 6 }).toEqual({ cols, rows, spare: true })
    await ui.unmount()
  }
}

test('a busy docked pane never grows its log past the rows it has', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `f${++n}` }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_$, e) {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model }
    return { turnId: e.turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  await idleWithPrompts($, 40)
  await $.session.measure({
    context: { window: 200_000, tokens: 50_000, percent: 25 },
    cost: { usd: 1.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 19 }, { kind: 'seven_day', percentUsed: 3 }],
    changed: ['context', 'rateLimits'],
  } as never)
  await $.turn.start({ text: 'go', turnId: 'F1' })
  await $.agent.spawn(spawn('fable-advisor:fable-advisor', 'review'))
  for (const d of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) await $.agent.spawn(spawn('general-purpose', `task ${d} with a long description that wraps`))
  for (let i = 0; i < 8; i += 1) await $.tool.check({ tool: 'Bash', input: { command: `ls ${i}` }, tool_use_id: `f-k${i}` })
  for await (const _ of $.turn.step({ turnId: 'F1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'loop1' })) void _
  // The gate's drill-down and a card's detail open, as the person leaves them across redraws.
  const first = await $.ui.mount({ ...pane(58), surface: 'terminal' })
  await first.press({ key: 'gate-shell' })
  await first.press({ key: 'card-f8' })
  expect(await first.find({ text: /^task seven with a long description that wraps$/ })).toBeDefined()
  expect(await first.find({ text: /ls 7/ })).toBeDefined()
  await first.unmount()
  await fillsWithoutOverflow($, [[58, 20], [58, 40], [58, 55], [58, 70], [58, 90], [120, 30], [120, 50], [120, 80]])
})

test('a quiet docked pane with cards and advice never grows its log past the rows it has', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: e.subagentType.startsWith('fable') ? 'adv' : `q${++n}` }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await idleWithPrompts($, 40)
  await $.session.measure({
    context: { window: 200_000, tokens: 50_000, percent: 25 },
    cost: { usd: 1.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 19 }],
    changed: ['context', 'rateLimits'],
  } as never)
  await $.turn.start({ text: 'go', turnId: 'Q1' })
  await $.agent.spawn(spawn('fable-advisor:fable-advisor', 'review'))
  await $.turn.complete({ answer: 'Ship it after one more test.', durationMs: 10, isAborted: false, turnId: 'Q1', agentId: 'adv', reason: 'answer' })
  for (const d of ['one', 'two']) await $.agent.spawn(spawn('general-purpose', `task ${d}`))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'q-k1' })
  await fillsWithoutOverflow($, [[58, 30], [58, 45], [58, 60], [58, 75], [120, 40], [120, 60]])
})

// ---------------------------------------------------------------- gate drill-down fill

test('the open drill-down lists 5 checks, or with dockFill up to half the spare rows, never more than exist', () => {
  // Off: the newest 5, or all when fewer exist, whatever the spare rows.
  expect([gateRows(0, 40), gateRows(30, 40), gateRows(30, 3)]).toEqual([5, 5, 3])
  // On: no spare rows, the old 5; half of them more (rounded down); capped by the checks that exist.
  expect([gateRows(0, 40, true), gateRows(-6, 40, true), gateRows(1, 40, true), gateRows(7, 40, true), gateRows(60, 40, true)]).toEqual([5, 5, 5, 8, 35])
  expect([gateRows(30, 3, true), gateRows(30, 7, true), gateRows(30, 20, true), gateRows(30, 80, true)]).toEqual([3, 7, 20, 20])
})

/** How many of `ls 0`..`ls n-1` the gate's drill-down shows. */
const checksShown = async (ui: { find: (q: { text: RegExp }) => Promise<unknown> }, n: number) => {
  let shown = 0
  for (let i = 0; i < n; i += 1) if (await ui.find({ text: new RegExp(`^Bash → ls ${i}$`) })) shown += 1
  return shown
}

const fortyShellChecks = async ($: Parameters<TestBody>[0], on: On) => {
  engine(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await idleWithPrompts($, 40)
  for (let i = 0; i < 40; i += 1) await $.tool.check({ tool: 'Bash', input: { command: `ls ${i}` }, tool_use_id: `d-k${i}` })
  const first = await $.ui.mount({ ...pane(58, 70), surface: 'terminal' })
  await first.press({ key: 'gate-shell' })
  await first.unmount()
  return $.ui.mount({ ...pane(58, 70), surface: 'terminal' })
}

test('a tall docked pane lists far more than 5 checks in the open drill-down and still fits', async ($, on) => {
  const ui = await fortyShellChecks($, on)
  const shown = await checksShown(ui, 40)
  expect(shown > 15).toBe(true)
  expect(await ui.find({ text: /^Bash → ls 39$/ })).toBeDefined() // newest last, never the one cut
  expect(await ui.find({ text: /shell 40 ▾/ })).toBeDefined()
  const tree = await ui.drawn()
  expect(rowsAt(tree, 58) <= 70).toBe(true)
  expect(logLinesOf(tree) >= shown - 1).toBe(true) // the log keeps at least the other half
  await ui.unmount()
  await fillsWithoutOverflow($, [[58, 20], [58, 40], [58, 55], [58, 90], [120, 30], [120, 60], [120, 90]])
})

test('dockFill off keeps the drill-down at 5 checks', { options: { dockFill: false } }, async ($, on) => {
  const ui = await fortyShellChecks($, on)
  expect(await checksShown(ui, 40)).toBe(5)
  expect(await ui.find({ text: /^Bash → ls 35$/ })).toBeDefined()
  expect(await ui.find({ text: /^Bash → ls 34$/ })).toBeUndefined()
  await ui.unmount()
})

test('a drill-down with few checks shows them all and the log takes the rest', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await idleWithPrompts($, 60)
  for (let i = 0; i < 7; i += 1) await $.tool.check({ tool: 'Bash', input: { command: `ls ${i}` }, tool_use_id: `s-k${i}` })
  const first = await $.ui.mount({ ...pane(58, 70), surface: 'terminal' })
  await first.press({ key: 'gate-shell' })
  await first.unmount()
  const ui = await $.ui.mount({ ...pane(58, 70), surface: 'terminal' })
  expect(await checksShown(ui, 7)).toBe(7)
  const tree = await ui.drawn()
  expect(rowsAt(tree, 58) <= 70).toBe(true)
  expect(70 - rowsAt(tree, 58) <= 6).toBe(true) // no rows held back for checks that do not exist
  await ui.unmount()
})
