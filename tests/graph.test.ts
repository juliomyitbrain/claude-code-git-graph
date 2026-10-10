import { expect, test } from 'claude-code/testing'

import {
  fitText,
  layout,
  logArgv,
  parseLog,
  SOURCE_BUDGET,
  TEXT_BUDGET,
  toChunks,
  toText,
} from '../hooks/graph'

// A record as git prints one; who, when and the message's body when given.
const record = (
  hash: string,
  parents: string,
  refs: string,
  subject: string,
  ...details: string[]
) => `${[hash, parents, refs, subject, ...details].join('\x1f')}\x1e\n`

// The whole history as one drawing: the tests' logs are short enough.
const drawing = (log: string, width: number): string => {
  const [chunk, ...rest] = toChunks(layout(parseLog(log)), { width })

  expect(rest).toHaveLength(0)

  return chunk?.source ?? ''
}

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

const linear = (count: number, subject: (index: number) => string): string => {
  let log = ''

  for (let index = 0; index < count; index += 1) {
    log += record(`c${index}`, `c${index + 1}`, '', subject(index))
  }

  return log
}

// Every x and width a drawing places a mark at, to hold against its width.
const reach = (source: string): number => {
  let right = 0

  for (const [, cx] of source.matchAll(/<circle cx="([\d.]+)"/g)) {
    right = Math.max(right, Number(cx))
  }

  for (const [, x, width] of source.matchAll(/<rect x="([\d.]+)"[^>]* width="([\d.]+)"/g)) {
    right = Math.max(right, Number(x) + Number(width))
  }

  return right
}

test('parses commits, parents and refs out of git log', () => {
  const commits = parseLog(LOG)

  expect(commits.map(commit => commit.hash)).toEqual(['M', 'B1', 'A2', 'A1', 'R'])
  expect(commits[0]?.parents).toEqual(['A2', 'B1'])
  expect(commits[0]?.isHead).toBe(true)
  expect(commits[0]?.refs).toEqual([
    { name: 'main', kind: 'branch' },
    { name: 'origin/main', kind: 'branch' },
  ])
  expect(commits[4]?.refs).toEqual([{ name: 'v1', kind: 'tag' }])
  expect(commits[4]?.parents).toEqual([])
})

test('reads who, when and the message, and drops a record cut short', () => {
  const commits = parseLog(
    record(
      'A',
      'B',
      '',
      'Subject',
      'Ana P\u00e9rez',
      '2026-10-09 18:05',
      'First line\n\n  indented \u001b[1m\nlast\n',
    ) + 'B\x1f\x1f\x1fCut off mid-rec',
  )

  expect(commits).toHaveLength(1)
  expect(commits[0]?.author).toBe('Ana P\u00e9rez')
  expect(commits[0]?.date).toBe('2026-10-09 18:05')
  expect(commits[0]?.body).toEqual(['First line', '  indented  [1m', 'last'])
  expect(parseLog(LOG)[0]?.body).toEqual([])
})

test('takes no commit from the bytes of a message', () => {
  // As git writes them with -z: a NUL after each record's separator.
  const forged = 'ok\x1e\nF\x1f\x1fHEAD -> refs/heads/evil\x1fForged row\x1fx\x1fy\x1f'
  const commits = parseLog(
    `A\x1fB\x1frefs/heads/main\x1fReal\x1fAna\x1f2026-10-09 18:05\x1f${forged}\x1e\0` +
      'B\x1f\x1f\x1fRoot\x1fAna\x1f2026-10-08 10:00\x1f\x1e\0',
  )

  expect(commits.map(commit => commit.hash)).toEqual(['A', 'B'])
  expect(commits.some(commit => commit.isHead)).toBe(false)
  // What the message held is kept as text, its control bytes blanked.
  expect(commits[0]?.body).toEqual(['ok', 'F  HEAD -> refs/heads/evil Forged row x y'])
  expect(logArgv(151)).toContain('-z')
})

test('asks git for full ref names and leaves its own namespaces out', () => {
  const argv = logArgv(151)

  // The message is asked for, and left out where a read has to be lean.
  expect(argv.at(-1)).toContain('%b')
  expect(logArgv(151, false).at(-1)).not.toContain('%b')
  expect(logArgv(151, false).at(-1)).toContain('%an')

  expect(argv).toContain('--decorate=full')
  expect(argv).toContain('--max-count=151')
  // Each --exclude counts only when it stands before the --all it trims.
  expect(argv.indexOf('--exclude=refs/stash') < argv.indexOf('--all')).toBe(true)
  expect(argv.indexOf('--exclude=refs/notes/*') < argv.indexOf('--all')).toBe(true)
})

test('draws no badge for a word of git that is no ref', () => {
  const [shallow, detached, other] = parseLog(
    record('S', '', 'grafted, HEAD -> refs/heads/main, refs/remotes/origin/HEAD', 's') +
      record('D', '', 'HEAD, replaced, tag: refs/tags/v2', 'd') +
      record('O', '', 'refs/notes/commits, refs/stash', 'o'),
  )

  expect(shallow?.refs.map(ref => ref.name)).toEqual(['main', 'origin/HEAD'])
  expect(detached?.isHead).toBe(true)
  expect(detached?.refs).toEqual([{ name: 'v2', kind: 'tag' }])
  expect(other?.refs).toEqual([])
})

test('takes control characters out of subjects and ref names', () => {
  const [commit] = parseLog(
    record(
      'E',
      '',
      'HEAD -> refs/heads/caf\u0085x',
      'release \u001b[32mv1\u001b[0m donâ\u0080\u0099t ￾',
    ),
  )

  expect(commit?.subject).toBe('release  [32mv1 [0m donâ  t  ')
  expect(commit?.refs[0]?.name).toBe('caf x')
})

test('lays a merged branch out in a lane of its own', () => {
  const { rows, columns } = layout(parseLog(LOG))

  expect(columns).toBe(2)
  expect(rows.map(row => row.column)).toEqual([0, 1, 0, 0, 0])
  // The merge sends one line down its own lane and one over to the branch.
  expect(rows[0]?.edges.map(edge => [edge.from, edge.to])).toEqual([
    [0, 0],
    [0, 1],
  ])
  // The branch's lane comes back to the main line at the commit it left from.
  expect(rows[2]?.edges.map(edge => [edge.from, edge.to])).toEqual([
    [1, 0],
    [0, 0],
  ])
  // The two lanes are told apart by colour.
  expect(rows[1]?.color).not.toBe(rows[0]?.color)
  expect(rows[3]?.color).toBe(rows[0]?.color)
})

test('draws a dot a commit, a ring for HEAD, and escapes the subject', () => {
  const source = drawing(LOG, 600)

  expect(source.match(/<circle/g)).toHaveLength(6)
  expect(source).toContain('Fix &lt;y&gt; &amp; &quot;z&quot;')
  expect(source).toContain('>main<')
  expect(source).toContain('>v1<')
  expect(source.startsWith('<svg ')).toBe(true)
})

test('holds a card of details a commit, opened by a click on its row', () => {
  const hash = 'c99b775e0bb1b02f5fac892696ec6614af95795a'
  const source = drawing(
    record(
      hash,
      'P',
      'HEAD -> refs/heads/main, tag: refs/tags/v2',
      'Add the details card <b>',
      'Ana P\u00e9rez',
      '2026-10-09 18:05',
      'Why it is there.\n\n- one\n- two\n- three\n- four',
    ) + record('P', '', '', 'Root'),
    600,
  )

  // A row to click and a card a commit; the card is hidden until its row's
  // click begins it, and a click off the card ends it.
  expect(source.match(/<rect id="h\d+" class="h"/g)).toHaveLength(2)
  expect(source.match(/<g display="none"><set attributeName="display"/g)).toHaveLength(2)
  expect(source).toContain(
    '<set attributeName="display" to="inline" begin="h0.click" end="b0.click"/>',
  )
  expect(source).toContain(`>${hash}<`)
  expect(source).toContain('>Ana P\u00e9rez \u00b7 2026-10-09 18:05<')
  expect(source).toContain('>main, tag v2<')
  expect(source).toContain('>Add the details card &lt;b&gt;<')
  // Seven lines a card: the message's head fills what the rest leaves, and
  // the last line counts what is left out.
  expect(source).toContain('>Why it is there.<')
  expect(source).toContain('>- one<')
  expect(source).not.toContain('>- two<')
  expect(source).toContain('>\u2026 3 more lines<')
  // No script and no handler attribute: the surface would strip either.
  expect(source).not.toContain('<script')
  expect(/\son[a-z]+=/.test(source)).toBe(false)
})

test('fits a card\'s lines to its width, whatever the script', () => {
  const cjk = '\u4e2d\u6587\u63d0\u4ea4\u8bf4\u660e'.repeat(8)
  const source = drawing(
    record('W', 'P', '', cjk, 'A'.repeat(90), '2026-10-09 18:05', 'W'.repeat(120)) +
      record('P', '', '', 'MERGE PULL REQUEST #23886 FROM HOMEBREW/MOVE-CASK-CI-COMMAND'),
    320,
  )
  // The card is 300 wide at 320: its lines have 280 between the paddings.
  const subject = [...source.matchAll(/font-weight="600">([^<]+)</g)].map(
    ([, text]) => text ?? '',
  )
  const wide = subject.filter(line => /[\u4e00-\u9fff]/.test(line))

  // 48 characters that fill a square each: both of the subject's lines, each
  // within the card, the second ending where it is cut.
  expect(wide.length).toBe(2)
  expect(wide.every(line => [...line].length * 12 <= 280 + 12)).toBe(true)
  expect(wide[1]?.endsWith('\u2026')).toBe(true)
  // Capitals count wider than the average letter: this subject breaks.
  expect(subject.filter(line => /^[A-Z#\d /-]+$/.test(line)).length > 1).toBe(true)
  // A long name and a long body line are cut with an ellipsis, not run on.
  expect(source).toMatch(/>A+\u2026</)
  expect(source).toMatch(/>W{5,25}\u2026</)
})

test('hides a card as the pointer leaves its drawing where the history is several', () => {
  const chunks = toChunks(layout(parseLog(linear(260, index => `Commit ${index}`))), {
    width: 600,
  })

  expect(chunks.length > 1).toBe(true)

  for (const chunk of chunks) {
    const sets = chunk.source.match(/<set attributeName="display"[^>]*>/g) ?? []

    expect(chunk.source.startsWith('<svg id="s" ')).toBe(true)
    expect(sets).toHaveLength(chunk.to - chunk.from)
    sets.forEach((set, index) => {
      expect(set).toBe(
        `<set attributeName="display" to="inline" begin="h${index}.click" end="b${index}.click;s.mouseleave"/>`,
      )
    })
    expect(chunk.source.length <= SOURCE_BUDGET).toBe(true)
  }

  // One drawing sees every click itself: it needs no such end.
  expect(drawing(linear(30, index => `Commit ${index}`), 600)).not.toContain(
    'mouseleave',
  )
})

test('lets a double click on a row leave its card open', () => {
  const source = drawing(linear(3, index => `Commit ${index}`), 600)

  // For a moment after the click the backdrop over the row takes no pointer.
  expect(source).toMatch(
    /<rect id="b1" width="600" height="\d+" fill="#888888" fill-opacity="0"><set attributeName="pointer-events" to="none" begin="h1\.click" dur="0\.4s"\/><\/rect>/,
  )
})

test('opens a card inside its drawing, over the row where none fits under', () => {
  const [chunk] = toChunks(layout(parseLog(linear(30, index => `Commit ${index}`))), {
    width: 600,
  })
  const cards = [
    ...(chunk?.source ?? '').matchAll(
      /<g transform="translate\(([\d.]+) ([\d.]+)\)"><rect class="c" width="([\d.]+)" height="([\d.]+)"/g,
    ),
  ].map(([, x, y, wide, tall]) => ({
    x: Number(x),
    y: Number(y),
    wide: Number(wide),
    tall: Number(tall),
  }))

  expect(cards).toHaveLength(30)
  expect(chunk?.height).toBe(30 * 22)

  cards.forEach((card, index) => {
    expect(card.x >= 0 && card.x + card.wide <= 600).toBe(true)
    expect(card.y >= 0 && card.y + card.tall <= 30 * 22).toBe(true)
    // Never over its own row.
    expect(card.y >= (index + 1) * 22 || card.y + card.tall <= index * 22).toBe(true)
  })
  // The first opens under its row, the last over it.
  expect((cards[0]?.y ?? 0) > 22).toBe(true)
  expect((cards[29]?.y ?? 0) < 29 * 22).toBe(true)
})

test('keeps every card inside a drawing of thirteen rows, off its own row', () => {
  // The tallest card there is: refs, a subject of two lines, a long message.
  const log = linear(40, index => `Commit ${index} ${'word '.repeat(40)}`).replaceAll(
    '\x1f\x1f',
    '\x1frefs/heads/b\x1f',
  ).replaceAll('\x1e', '\x1fAna\x1f2026-10-09 18:05\x1fa\nb\nc\nd\ne\nf\x1e')
  const chunks = toChunks(layout(parseLog(log)), { width: 420, maxRows: 13 })

  expect(chunks.map(chunk => chunk.to - chunk.from)).toEqual([13, 13, 13, 1])

  for (const chunk of chunks) {
    const cards = [
      ...chunk.source.matchAll(
        /<g transform="translate\(([\d.]+) ([\d.]+)\)"><rect class="c" width="([\d.]+)" height="([\d.]+)"/g,
      ),
    ].map(([, , y, , tall]) => ({ y: Number(y), tall: Number(tall) }))

    // No drawing is taller than the 300 px a surface draws at its own size.
    expect(chunk.height <= 300).toBe(true)
    expect(cards).toHaveLength(chunk.to - chunk.from)

    cards.forEach((card, index) => {
      expect(card.tall).toBe(126)
      expect(card.y >= 0 && card.y + card.tall <= chunk.height).toBe(true)
      expect(card.y >= (index + 1) * 22 || card.y + card.tall <= index * 22).toBe(true)
    })
  }
})

test('splits a long history into drawings that each fit and meet', () => {
  const graph = layout(
    parseLog(
      linear(1500, () => 'x'.repeat(200)).replaceAll(
        '\x1e',
        '\x1fAna\x1f2026-10-09 18:05\x1fBody one\nBody two\x1e',
      ),
    ),
  )
  const chunks = toChunks(graph, { width: 1000 })

  expect(chunks.length > 5).toBe(true)
  expect(chunks[0]?.from).toBe(0)
  expect(chunks.at(-1)?.to).toBe(1500)

  chunks.forEach((chunk, index) => {
    expect(chunk.source.length <= SOURCE_BUDGET).toBe(true)
    expect(chunk.to > chunk.from).toBe(true)
    expect(chunk.source.match(/<rect id="h\d+"/g)).toHaveLength(chunk.to - chunk.from)

    if (index > 0) {
      // Each starts where the one before ended, and draws the line that
      // comes down into it from above its top edge.
      expect(chunk.from).toBe(chunks[index - 1]?.to)
      expect(chunk.source).toContain('M10 -11V11')
    }
  })
})

test('keeps badges inside a narrow drawing and a subject beside them', () => {
  const name = 'feature/JIRA-1234-add-billing-export'
  const log =
    record(
      'H',
      'P',
      `HEAD -> refs/heads/${name}, refs/remotes/origin/${name}`,
      'Add billing export endpoint',
    ) + record('P', '', 'refs/heads/main', 'Root')

  for (const width of [320, 360, 450, 600]) {
    const source = drawing(log, width)

    expect(reach(source) <= width).toBe(true)
    expect(source).toContain('>Add ')
  }
})

test('keeps many lanes inside the drawing', () => {
  let log = ''

  // Sixty branch tips, each on a commit of its own: sixty lanes side by side.
  for (let lane = 0; lane < 60; lane += 1) {
    log += record(`t${lane}`, `b${lane}`, `refs/heads/team-${lane}`, `Work ${lane}`)
  }

  for (let lane = 0; lane < 60; lane += 1) {
    log += record(`b${lane}`, 'base', '', `Start ${lane}`)
  }

  const graph = layout(parseLog(log + record('base', '', '', 'Base')))

  expect(graph.columns).toBe(60)

  for (const width of [320, 600, 1000]) {
    // Sixty lines a row: more than one drawing's worth.
    const chunks = toChunks(graph, { width })

    for (const { source } of chunks) {
      expect(source.length <= SOURCE_BUDGET).toBe(true)
      expect(reach(source) <= width).toBe(true)
      expect(source).not.toContain('NaN')
    }

    expect(chunks.at(-1)?.source).toContain('>Base<')
  }
})

test('cuts the text rows to the pane and to what one tree draws', () => {
  const graph = layout(parseLog(linear(1500, () => 'y'.repeat(300))))
  const lines = fitText(toText(graph), 100)

  expect(lines.every(line => [...line].length <= 100)).toBe(true)
  expect(lines.join('').length <= TEXT_BUDGET).toBe(true)
  expect(lines.length < 1500).toBe(true)
  expect(lines.length > 500).toBe(true)
  expect(fitText(toText(layout(parseLog(LOG))), 100)).toHaveLength(5)
})
