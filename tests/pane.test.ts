import { expect, test } from 'claude-code/testing'

// The tests' environment has timers; its typings name none.
declare const setTimeout: (handler: () => void, ms: number) => unknown

// A record as git prints one; who, when and the message's body when given.
const record = (
  hash: string,
  parents: string,
  refs: string,
  subject: string,
  ...details: string[]
) => `${[hash, parents, refs, subject, ...details].join('\x1f')}\x1e\n`

// main: R - A1 - A2 - M, with feat/x (B1) branched at A1 and merged at M.
const LOG =
  record(
    'M',
    'A2 B1',
    'HEAD -> refs/heads/main, refs/remotes/origin/main',
    'Merge feat/x',
  ) +
  record('B1', 'A1', 'refs/heads/feat/x', 'Add x') +
  record('A2', 'A1', '', 'Fix <y> & "z"') +
  record('A1', 'R', '', 'Second') +
  record('R', '', 'tag: refs/tags/v1', 'Root')

const OLD =
  record('B', 'A', 'HEAD -> refs/heads/main', 'Second') +
  record('A', '', '', 'First')
const NEW = record('C', 'B', 'HEAD -> refs/heads/main', 'Third') + OLD.replace(
  'HEAD -> refs/heads/main',
  '',
)

const PANE = {
  title: 'Git graph',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const DESKTOP = {
  plugin: 'git-graph',
  surface: 'desktop',
  component: 'Pane',
  requestId: 'git-graph',
  props: PANE,
} as const

const TERMINAL = { ...DESKTOP, surface: 'terminal' } as const

const ok = (stdout: string) => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const ran = { result: { stdout: '', stderr: '', interrupted: false } }

const tick = () =>
  new Promise<void>(resolve => {
    setTimeout(resolve, 1)
  })

// The command as a person types it at the prompt.
const TYPED = {
  command: 'git-graph',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

test('the pane draws the graph as an Svg on the desktop', async ($, on) => {
  let runs = 0

  on('process.run', ($, e) => {
    runs += 1
    expect(e.argv.slice(0, 2)).toEqual(['git', 'log'])

    return { value: ok(LOG) }
  })

  const ui = await $.ui.mount(DESKTOP)
  const svg = await ui.find({ type: 'Svg' })

  expect(String(svg?.props.source).match(/<circle/g)).toHaveLength(6)
  expect(svg?.props.alt).toBe(
    'Commit graph of 5 commits, HEAD at "Merge feat/x".',
  )
  // Drawn interactive, so a click on a commit opens its card in the drawing,
  // and at the drawing's own size, so the surface does not shrink it.
  expect(svg?.props.isInteractive).toBe(true)
  expect(svg?.props.width).toBe(420)
  // Five rows, and the room the last one's card needs under them.
  expect(Number(svg?.props.height) >= 5 * 22).toBe(true)
  expect(Number(svg?.props.height) <= 300).toBe(true)
  expect(String(svg?.props.source)).toContain(
    ` width="420" height="${svg?.props.height}" `,
  )
  expect(
    String(svg?.props.source).match(/<set attributeName="display"/g),
  ).toHaveLength(5)
  expect(await ui.find({ key: 'more' })).toBeUndefined()
  expect(runs).toBe(1)

  await ui.press({ key: 'refresh' })

  expect(runs).toBe(2)
  await ui.unmount()
})

test('the pane falls back to text where there is no Svg', async ($, on) => {
  on('process.run', () => ({ value: ok(LOG) }))

  const ui = await $.ui.mount(TERMINAL)

  expect(await ui.find({ type: 'Text', text: /◉ {3}\[main\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /│ ● \[feat\/x\] Add x/ })).toBeDefined()
  await ui.unmount()
})

test('the pane says so outside a repository and when git says nothing', async ($, on) => {
  let stderr = 'fatal: not a git repository (or any of the parent directories): .git'

  on('process.run', () => ({ value: { ...ok(''), exitCode: 128, stderr } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...DESKTOP, surface })

    expect(
      await ui.find({ type: 'Text', text: /not a git repository/ }),
    ).toBeDefined()

    stderr = ''
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ type: 'Text', text: /^git log failed\.$/ })).toBeDefined()
    // What was read is kept until a refresh: leave the next surface a fresh one.
    stderr = 'fatal: not a git repository'
    await ui.press({ key: 'refresh' })
    await ui.unmount()
  }
})

test('the pane is drawn whatever control characters git prints', async ($, on) => {
  on('process.run', () => ({
    value: ok(
      record(
        'E',
        'P',
        'HEAD -> refs/heads/caf\u0085x',
        'release \u001b[32mv1.2.3\u001b[0m',
      ) + record('P', '', '', 'donâ\u0080\u0099t break'),
    ),
  }))

  const desktop = await $.ui.mount(DESKTOP)

  expect((await desktop.find({ type: 'Svg' }))?.props.alt).toBe(
    'Commit graph of 2 commits, HEAD at "release  [32mv1.2.3 [0m".',
  )
  await desktop.unmount()

  const terminal = await $.ui.mount(TERMINAL)

  expect(await terminal.find({ type: 'Text', text: /\[caf x\] release/ })).toBeDefined()
  await terminal.unmount()
})

test('offers more when the history is longer than a page', async ($, on) => {
  let log = ''

  for (let index = 0; index < 400; index += 1) {
    log += record(`c${index}`, `c${index + 1}`, '', `Commit ${index}`)
  }

  const asked: number[] = []

  on('process.run', ($, e) => {
    const count = Number(
      e.argv.find(arg => arg.startsWith('--max-count='))?.split('=')[1],
    )
    asked.push(count)

    return { value: ok(log.split('\n').slice(0, count).join('\n')) }
  })

  const ui = await $.ui.mount(DESKTOP)

  expect(asked).toEqual([151])
  await ui.press({ key: 'more' })
  expect(asked).toEqual([151, 301])

  // The page is longer than one drawing holds: several, one under the other.
  const drawings = await ui.findAll({ type: 'Svg' })
  const dots = drawings
    .map(one => String(one.props.source).match(/<circle/g)?.length ?? 0)
    .reduce((sum, count) => sum + count, 0)

  // Thirteen rows a drawing: none taller than a surface draws at its size.
  expect(drawings).toHaveLength(Math.ceil(300 / 13))
  expect(drawings.every(one => Number(one.props.height) <= 300)).toBe(true)
  expect(dots).toBe(300)
  expect(drawings[1]?.props.alt).toMatch(/^Commits \d+ to \d+\.$/)
  // Every one of them takes clicks, and they stand newest first.
  expect(drawings.every(one => one.props.isInteractive === true)).toBe(true)
  expect(String(drawings[0]?.props.source)).toContain('>Commit 0<')
  expect(String(drawings.at(-1)?.props.source)).toContain('>Commit 299<')
  expect(await ui.find({ key: 'more' })).toBeDefined()
  await ui.unmount()

  // On the terminal the button stands above the rows.
  const terminal = await $.ui.mount(TERMINAL)

  expect(await terminal.find({ key: 'more' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /300 commits/ })).toBeDefined()
  await terminal.unmount()
})

test('a Bash call comes back as the tool answered it', async ($, on) => {
  on('process.run', () => ({ value: ok(LOG) }))
  on('tool.call', { tool: 'Bash' }, ($, e) =>
    e.command === 'git push'
      ? { deny: 'not allowed' }
      : { result: { stdout: `ran ${e.command}`, stderr: '', interrupted: false } },
  )

  for (const command of ['git status', 'gh pr list', 'ls -la', 'cat .gitignore']) {
    expect(await $.tool.call({ tool: 'Bash', command })).toEqual({
      result: { stdout: `ran ${command}`, stderr: '', interrupted: false },
    })
  }

  expect(await $.tool.call({ tool: 'Bash', command: 'git push' })).toEqual({
    deny: 'not allowed',
  })
})

test('the pane reloads after a git or gh command and after no other', async ($, on) => {
  let reads = 0

  on('process.run', () => {
    reads += 1

    return { value: ok(LOG) }
  })
  on('tool.call', { tool: 'Bash' }, () => ran)

  const ui = await $.ui.mount(DESKTOP)

  expect(reads).toBe(1)

  await $.tool.call({ tool: 'Bash', command: 'ls -la && cat .gitignore' })
  await ui.find({ type: 'Svg' })
  expect(reads).toBe(1)

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  await ui.find({ type: 'Svg' })
  expect(reads).toBe(2)

  await $.tool.call({ tool: 'Bash', command: 'cd sub && gh pr merge 3' })
  await ui.find({ type: 'Svg' })
  expect(reads).toBe(3)
  await ui.unmount()
})

test('the pane reloads when the session moves to another folder', async ($, on) => {
  let log = OLD

  on('process.run', () => ({ value: ok(log) }))
  on('classic.CwdChanged', () => ({}))

  const ui = await $.ui.mount(DESKTOP)

  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe(
    'Commit graph of 2 commits, HEAD at "Second".',
  )

  log = record('Z', '', 'HEAD -> refs/heads/trunk', 'Other repository')
  await $.classic.CwdChanged({ old_cwd: '/repo/a', new_cwd: '/repo/b' })

  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe(
    'Commit graph of 1 commits, HEAD at "Other repository".',
  )
  await ui.unmount()
})

test('a read that a later change overtook is neither kept nor drawn', async ($, on) => {
  let log = OLD
  let reads = 0
  let holdFrom = Infinity
  const gates = new Map<number, () => void>()

  // git log answers with what the repository held when the log began, and
  // from read `holdFrom` on only once the test lets that read go.
  on('process.run', async () => {
    reads += 1
    const mine = reads
    const snapshot = log

    if (mine >= holdFrom) {
      await new Promise<void>(resolve => {
        gates.set(mine, resolve)
      })
    }

    return { value: ok(snapshot) }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    if (e.command.includes('commit')) {
      log = NEW
    }

    return ran
  })

  const ui = await $.ui.mount(DESKTOP)

  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe(
    'Commit graph of 2 commits, HEAD at "Second".',
  )

  // A reload starts and its git log hangs; a commit lands meanwhile.
  holdFrom = 2
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const reloading = ui.find({ type: 'Svg' })

  for (let turn = 0; turn < 200 && !gates.has(2); turn += 1) {
    await tick()
  }

  expect(gates.has(2)).toBe(true)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m Third' })
  holdFrom = Infinity
  gates.get(2)?.()
  await reloading

  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe(
    'Commit graph of 3 commits, HEAD at "Third".',
  )
  await ui.unmount()
})

test('the command opens the pane and says when it is not drawn', async ($, on) => {
  let isPlaced = true
  const opened: unknown[] = []

  on('process.run', () => ({ value: ok(LOG) }))
  on('ui.open', ($, e) => {
    opened.push(e)

    return {
      value: isPlaced
        ? { isPlaced: true }
        : { isPlaced: false, reason: 'too narrow' },
    }
  })

  expect(await $.command.run(TYPED)).toEqual({
    text: 'Git graph pane opened.',
  })
  expect(opened).toEqual([{ id: 'git-graph', title: 'Git graph' }])

  isPlaced = false

  expect(await $.command.run(TYPED)).toEqual({
    text: 'Git graph pane is open but not drawn: too narrow',
  })
})

test('stops offering more at the most it draws', async ($, on) => {
  let log = ''

  for (let index = 0; index < 1600; index += 1) {
    log += record(`c${index}`, `c${index + 1}`, '', `Commit ${index}`)
  }

  on('process.run', ($, e) => {
    const count = Number(
      e.argv.find(arg => arg.startsWith('--max-count='))?.split('=')[1],
    )

    return { value: ok(log.split('\n').slice(0, count).join('\n')) }
  })

  const ui = await $.ui.mount(DESKTOP)

  for (let press = 0; press < 9; press += 1) {
    await ui.press({ key: 'more' })
  }

  expect(await ui.find({ type: 'Text', text: /^1500 commits/ })).toBeDefined()
  expect(await ui.find({ key: 'more' })).toBeUndefined()
  await ui.press({ key: 'refresh' })
  await ui.unmount()
})

test('draws each surface at its own width', async ($, on) => {
  on('process.run', () => ({ value: ok(LOG) }))

  const wide = await $.ui.mount(DESKTOP)
  const other = await $.ui.mount({
    ...DESKTOP,
    surface: 'vscode',
    props: { ...PANE, bodyColumns: 100 },
  })
  const widthOf = async (ui: typeof wide | typeof other) =>
    /<svg id="s" [^>]*? width="(\d+)"/.exec(
      String((await ui.find({ type: 'Svg' }))?.props.source),
    )?.[1]

  // 5.25 px a cell: 100 cells and 80.
  expect(await widthOf(other)).toBe('525')
  expect(await widthOf(wide)).toBe('420')
  await other.unmount()
  await wide.unmount()
})

test('keeps the alt short whatever the subject', async ($, on) => {
  on('process.run', () => ({
    value: ok(record('H', '', 'HEAD -> refs/heads/main', 'x'.repeat(5000))),
  }))

  const ui = await $.ui.mount(DESKTOP)
  const alt = String((await ui.find({ type: 'Svg' }))?.props.alt)

  expect(alt.length < 160).toBe(true)
  expect(alt).toMatch(/^Commit graph of 1 commits, HEAD at "x+\u2026"\.$/)
  await ui.press({ key: 'refresh' })
  await ui.unmount()
})

test('reads the rows again without messages when git wrote too much', async ($, on) => {
  const body = 'Why.\nHow.'
  const full =
    record('C', 'B', 'HEAD -> refs/heads/main', 'Third', 'Ana', '2026-10-09 18:05', body) +
    record('B', 'A', '', 'Second', 'Ana', '2026-10-08 10:00', body) +
    record('A', '', '', 'First', 'Ana', '2026-10-07 09:00', body)
  const lean = full.replaceAll(`\x1f${body}`, '\x1f')
  const asked: boolean[] = []
  let isLeanCut = false

  on('process.run', ($, e) => {
    const withBody = e.argv.some(arg => arg.includes('%b'))
    asked.push(withBody)

    // The read with messages is cut inside its second record.
    return {
      value: withBody
        ? { ...ok(full.slice(0, full.indexOf('Second') + 3)), isStdoutTruncated: true }
        : { ...ok(isLeanCut ? '' : lean), isStdoutTruncated: isLeanCut },
    }
  })

  const ui = await $.ui.mount(DESKTOP)
  const svg = await ui.find({ type: 'Svg' })
  const source = String(svg?.props.source)

  expect(asked).toEqual([true, false])
  expect(svg?.props.alt).toBe('Commit graph of 3 commits, HEAD at "Third".')
  expect(source.match(/<rect id="h\d+"/g)).toHaveLength(3)
  // The commit read whole keeps its message; the ones past the cut have none.
  expect(source.match(/>Why\.</g)).toHaveLength(1)

  // A read cut before its first commit is not an empty repository.
  isLeanCut = true
  await ui.press({ key: 'refresh' })

  expect(
    await ui.find({ type: 'Text', text: /wrote more than can be read/ }),
  ).toBeDefined()
  isLeanCut = false
  await ui.press({ key: 'refresh' })
  await ui.unmount()
})
