// The graph itself, apart from the engine: git's log parsed into commits,
// commits laid out in lanes, lanes drawn as SVG (or as text for a terminal).
// A click on a commit opens a card of its details inside the drawing itself.

export type Ref = { name: string; kind: 'branch' | 'tag' }

export type Commit = {
  hash: string
  parents: string[]
  refs: Ref[]
  isHead: boolean
  subject: string
  author: string
  date: string
  // The message under the subject, a line an entry, the blank ones left out.
  body: string[]
}

// A line from this row's centre to the next row's centre, in lane units.
export type Edge = { from: number; to: number; color: number }

export type Row = {
  commit: Commit
  column: number
  color: number
  edges: Edge[]
  // The lanes a line crosses this row in, the commit's own aside.
  passing: number[]
}

export type Layout = { rows: Row[]; columns: number }

const FIELD = '\x1f'
const RECORD = '\x1e'

export const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ad%x1f%b%x1e'

// --all walks every ref, so the namespaces git keeps for itself are left out
// first; full names tell a ref from a word such as `grafted`; -z ends a
// record on a NUL, the one byte no message can hold.
export const logArgv = (count: number, withBody = true): string[] => [
  'git',
  'log',
  '--exclude=refs/stash',
  '--exclude=refs/notes/*',
  '--exclude=refs/prefetch/*',
  '--exclude=refs/replace/*',
  '--exclude=refs/original/*',
  '--all',
  '-z',
  '--decorate=full',
  '--date-order',
  '--date=format-local:%Y-%m-%d %H:%M',
  `--max-count=${count}`,
  `--format=${withBody ? LOG_FORMAT : LOG_FORMAT.replace('%b', '')}`,
]

// The engine refuses a tree with a control character in a Text or in an Svg's
// alt, and git prints one in a subject or a ref name as it is; the last two
// are characters XML does not take.
const clean = (text: string): string =>
  text.replace(/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/g, ' ')

const NAMESPACES: readonly { prefix: string; kind: Ref['kind'] }[] = [
  { prefix: 'refs/heads/', kind: 'branch' },
  { prefix: 'refs/remotes/', kind: 'branch' },
  { prefix: 'refs/tags/', kind: 'tag' },
]

const parseRefs = (decoration: string): { refs: Ref[]; isHead: boolean } => {
  const refs: Ref[] = []
  let isHead = false

  for (const part of decoration.split(', ')) {
    let name = part.trim()

    if (name === 'HEAD') {
      isHead = true
      continue
    }

    if (name.startsWith('HEAD -> ')) {
      isHead = true
      name = name.slice('HEAD -> '.length)
    } else if (name.startsWith('tag: ')) {
      name = name.slice('tag: '.length)
    }

    // What is left that is no full ref name is a word of git's own
    // (`grafted`, `replaced`), or a ref of a namespace not drawn.
    const space = NAMESPACES.find(({ prefix }) => name.startsWith(prefix))

    if (space !== undefined) {
      refs.push({ name: clean(name.slice(space.prefix.length)), kind: space.kind })
    }
  }

  return { refs, isHead }
}

export const parseLog = (stdout: string): Commit[] => {
  const commits: Commit[] = []
  // A record ends on its separator and, as git writes it, a NUL: the pair is
  // what no message can forge. Output that came without the NULs is split on
  // the separator alone.
  const end = `${RECORD}\0`
  const records = stdout.split(stdout.includes(end) ? end : RECORD)
  // What follows the last end is a blank, or the head of a record that
  // output cut off left unfinished.
  records.pop()

  for (const record of records) {
    const [
      hash = '',
      parents = '',
      decoration = '',
      subject = '',
      author = '',
      date = '',
      // The message is the last field, and may hold the separator itself.
      ...message
    ] = record.replace(/^\s+/, '').split(FIELD)
    const body = message.join(FIELD)

    if (hash === '') {
      continue
    }

    commits.push({
      hash,
      parents: parents.split(' ').filter(parent => parent !== ''),
      ...parseRefs(decoration),
      subject: clean(subject),
      author: clean(author),
      date: clean(date),
      body: body
        .split('\n')
        .map(line => clean(line).trimEnd())
        .filter(line => line !== ''),
    })
  }

  return commits
}

export const layout = (commits: readonly Commit[]): Layout => {
  // lanes[i] is the hash lane i runs down to, or null while the lane is free.
  const lanes: (string | null)[] = []
  const laneColors: number[] = []
  let nextColor = 0
  let columns = 0

  const freeLane = (): number => {
    const free = lanes.indexOf(null)

    return free === -1 ? lanes.length : free
  }

  // Each row's lines leave in a lane; where they land is known a row later,
  // from the commit that lane was running down to.
  const leaving: { from: number; lane: number; color: number }[][] = []
  const heading: (string | null)[][] = []
  const rows: Row[] = []

  for (const commit of commits) {
    const before = [...lanes]
    let column = lanes.indexOf(commit.hash)
    let color: number

    if (column === -1) {
      column = freeLane()
      color = nextColor++
      laneColors[column] = color
    } else {
      color = laneColors[column] ?? 0
    }

    const passing: number[] = []
    const out: { from: number; lane: number; color: number }[] = []

    before.forEach((hash, lane) => {
      if (hash === null) {
        return
      }

      if (hash === commit.hash) {
        lanes[lane] = null
      } else {
        passing.push(lane)
        out.push({ from: lane, lane, color: laneColors[lane] ?? 0 })
      }
    })

    commit.parents.forEach((parent, index) => {
      const known = lanes.indexOf(parent)

      // A first parent another lane to the right already runs down to keeps
      // this commit's lane too, so the line it is on stays straight and the
      // other one comes over to it.
      if (known !== -1 && !(index === 0 && known > column)) {
        const joined = index === 0 ? color : (laneColors[known] ?? 0)
        out.push({ from: column, lane: known, color: joined })

        return
      }

      const lane = index === 0 ? column : freeLane()
      lanes[lane] = parent
      laneColors[lane] = index === 0 ? color : nextColor++
      out.push({ from: column, lane, color: laneColors[lane] ?? 0 })
    })

    columns = Math.max(columns, column + 1, lanes.length)
    leaving.push(out)
    heading.push([...lanes])
    rows.push({ commit, column, color, edges: [], passing })
  }

  rows.forEach((row, index) => {
    const next = rows[index + 1]
    const lanesAfter = heading[index] ?? []

    row.edges = (leaving[index] ?? []).map(({ from, lane, color }) => ({
      from,
      to:
        next !== undefined && lanesAfter[lane] === next.commit.hash
          ? next.column
          : lane,
      color,
    }))
  })

  return { rows, columns }
}

export const PALETTE = [
  '#3b82f6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
] as const

const colorOf = (index: number): string =>
  PALETTE[index % PALETTE.length] ?? PALETTE[0]

const ROW = 22
const PAD = 10
const DOT = 4
const FONT = 12
const CHAR = 6
const BADGE_CHAR = 5.4
const MAX_BADGES = 2
// A badge's padding and the gap after it, the fewest characters worth a badge,
// and the characters of subject a row's badges leave room for.
const BADGE_PAD = 15
const MIN_BADGE = 6
const SUBJECT_ROOM = 12

// The most an Svg's `source` may hold, with room to spare.
export const SOURCE_BUDGET = 120_000

const escapeXml = (text: string): string =>
  clean(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const clip = (text: string, room: number): string => {
  const characters = [...text]

  if (characters.length <= room) {
    return text
  }

  return `${characters.slice(0, Math.max(1, room - 1)).join('')}…`
}

const round = (value: number): number => Math.round(value * 10) / 10

export type SvgOptions = { width: number }

// One drawing of a run of rows: the pane stacks them, each within what an
// Svg's source may hold.
export type Chunk = {
  source: string
  from: number
  to: number
  width: number
  height: number
}

type Geometry = {
  width: number
  stroke: number
  dot: number
  textX: number
  x: (column: number) => number
}

const geometry = (columns: number, width: number): Geometry => {
  // Many lanes squeeze together instead of pushing the text off the drawing,
  // their lines and dots thinning with them so they still read apart.
  const lane = Math.min(14, (width * 0.45) / Math.max(1, columns))

  return {
    width,
    stroke: round(Math.max(0.5, Math.min(2, lane / 3))),
    dot: round(Math.max(1.5, Math.min(DOT, (lane * 2) / 3))),
    textX: round(PAD + columns * lane + 4),
    x: column => round(PAD + column * lane),
  }
}

// One line from a row's centre at `top` down to `bottom`; `isOpen` where no
// row follows and it runs straight off the drawing.
const edgePath = (
  edge: Edge,
  top: number,
  bottom: number,
  { x }: Geometry,
  isOpen: boolean,
): string => {
  const from = x(edge.from)
  const to = isOpen ? from : x(edge.to)
  const bend = round((bottom - top) * 0.6)

  return from === to
    ? `M${from} ${top}V${bottom}`
    : `M${from} ${top}C${from} ${round(top + bend)} ${to} ${round(bottom - bend)} ${to} ${bottom}`
}

// A row's dot, its badges and its subject, the row centred at `top`.
const rowMarks = (row: Row, top: number, g: Geometry): string => {
  const color = colorOf(row.color)
  const cx = g.x(row.column)
  let marks = row.commit.isHead
    ? `<circle cx="${cx}" cy="${top}" r="${round(g.dot + 2)}" fill="${color}"/><circle cx="${cx}" cy="${top}" r="${round(g.dot * 0.55)}" fill="#ffffff"/>`
    : `<circle cx="${cx}" cy="${top}" r="${g.dot}" fill="${color}"/>`

  let at = g.textX
  const refs = row.commit.refs
  const span = (badge: string): number =>
    [...badge].length * BADGE_CHAR + BADGE_PAD
  // Badges end where a few characters of the subject still fit after them;
  // a ref with no room for a badge of its own is counted in the `+n` one.
  const end = g.width - PAD - SUBJECT_ROOM * CHAR
  const badges: string[] = []
  let right = g.textX

  for (const ref of refs.slice(0, MAX_BADGES)) {
    const after = refs.length - badges.length - 1
    const more = after > 0 ? span(`+${after}`) : 0
    const fits = Math.min(
      24,
      Math.floor((end - right - more - BADGE_PAD) / BADGE_CHAR),
    )

    if (fits < MIN_BADGE) {
      break
    }

    const badge = clip(ref.name, fits)
    badges.push(badge)
    right += span(badge)
  }

  const hidden = refs.length - badges.length

  if (hidden > 0) {
    badges.push(`+${hidden}`)
  }

  for (const badge of badges) {
    const badgeWidth = round([...badge].length * BADGE_CHAR + 10)
    marks +=
      `<rect x="${at}" y="${top - 8}" width="${badgeWidth}" height="16" rx="4" fill="${color}" fill-opacity="0.2" stroke="${color}"/>` +
      `<text x="${round(at + 5)}" y="${top + 3.5}" font-size="10" class="t" fill="#808080">${escapeXml(badge)}</text>`
    at = round(at + badgeWidth + 5)
  }

  const room = Math.floor((g.width - at - PAD) / CHAR)

  if (room > 3) {
    const weight = row.commit.isHead ? ' font-weight="600"' : ''
    marks += `<text x="${at}" y="${top + 4}" class="t" fill="#808080"${weight}>${escapeXml(clip(row.commit.subject, room))}</text>`
  }

  return marks
}

const CARD_PAD = 10
const CARD_LINE = 16
const MONO_CHAR = 6.7
const MAX_SUBJECT_LINES = 3
const MAX_BODY_LINES = 4
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'

// The px a character takes of a card's line, erring wide: the printable
// ASCII ones as the system face sets them in semibold at 12px, each rounded
// up, so none draws wider than it counts; the rest by their kind.
const ASCII_WIDTHS: readonly (readonly [number, string])[] = [
  [4, " ',./:;I\\ijl|"],
  [5, '!()[]ft{}'],
  [6, '*-1`r'],
  [7, '"?J_acksvxyz'],
  [9, '&48ABCDKRVXYZ'],
  [10, 'GHNOQUw'],
  [11, 'Mm'],
  [12, '%@W'],
]
const ASCII_WIDTH = new Map<string, number>(
  ASCII_WIDTHS.flatMap(([wide, characters]) =>
    [...characters].map((character): [string, number] => [character, wide]),
  ),
)

const charWidth = (character: string): number => {
  const code = character.codePointAt(0) ?? 0

  if (code < 0x7f) {
    return ASCII_WIDTH.get(character) ?? 8
  }

  // A mark set over or under the character before it, and what joins or
  // styles one: no width of their own.
  if (/[\p{Mn}\p{Me}\u200b-\u200d\ufe00-\ufe0f]/u.test(character)) {
    return 0
  }

  // Emoji and the symbols drawn as one; then what fills a square (CJK,
  // kana, hangul, the full width forms); then the other alphabets.
  if (code > 0xffff || (code >= 0x2190 && code <= 0x2bff)) {
    return 17
  }

  return code >= 0x1100 ? 12 : 10
}

const textWidth = (text: string): number => {
  let wide = 0

  for (const character of text) {
    wide += charWidth(character)
  }

  return wide
}

// The head of `text` that `room` px hold, an ellipsis where it is cut short
// (and, `isCut`, where more followed it than is given here).
const fit = (text: string, room: number, isCut = false): string => {
  if (!isCut && textWidth(text) <= room) {
    return text
  }

  const end = room - charWidth('…')
  let kept = ''
  let used = 0

  for (const character of text) {
    used += charWidth(character)

    if (used > end && kept !== '') {
      break
    }

    kept += character
  }

  return `${kept}…`
}

// Words laid on lines of at most `room` px, `most` lines at most. A word no
// line holds by itself (a path, a script that sets no spaces) breaks where
// the line ends.
const wrap = (text: string, room: number, most: number): string[] => {
  const lines: string[] = []
  const space = charWidth(' ')
  let line = ''
  let used = 0

  for (const word of text.split(' ')) {
    if (word === '') {
      continue
    }

    const wide = textWidth(word)

    if (line !== '' && used + space + wide <= room) {
      line += ` ${word}`
      used += space + wide
      continue
    }

    if (line !== '') {
      lines.push(line)
      line = ''
      used = 0
    }

    for (const character of word) {
      const one = charWidth(character)

      if (line !== '' && used + one > room) {
        lines.push(line)
        line = ''
        used = 0
      }

      line += character
      used += one
    }
  }

  if (line !== '') {
    lines.push(line)
  }

  const kept = lines.slice(0, most)

  if (lines.length > most) {
    kept[most - 1] = fit(lines[most - 1] ?? '', room, true)
  }

  return kept
}

// A commit's details as a card drawn from its own top left corner: the whole
// hash, who and when, its refs, the subject in full and the message's head.
const card = (
  commit: Commit,
  width: number,
): { markup: string; height: number } => {
  // The px a line has between the card's paddings.
  const room = width - 2 * CARD_PAD
  const texts: string[] = []
  let baseline = CARD_PAD + 10

  const line = (text: string, attributes: string): void => {
    texts.push(
      `<text x="${CARD_PAD}" y="${baseline}" class="t" fill="#808080"${attributes}>${escapeXml(text)}</text>`,
    )
    baseline += CARD_LINE
  }

  line(
    clip(commit.hash, Math.max(8, Math.floor(room / MONO_CHAR))),
    ` font-family="${MONO}" font-size="11"`,
  )

  const who = [commit.author, commit.date].filter(part => part !== '').join(' · ')

  if (who !== '') {
    line(fit(who, room), ' opacity="0.7"')
  }

  if (commit.refs.length > 0) {
    const names = commit.refs.map(ref =>
      ref.kind === 'tag' ? `tag ${ref.name}` : ref.name,
    )
    line(fit(names.join(', '), room), ' opacity="0.7"')
  }

  for (const part of wrap(commit.subject, room, MAX_SUBJECT_LINES)) {
    line(part, ' font-weight="600"')
  }

  for (const part of commit.body.slice(0, MAX_BODY_LINES)) {
    line(fit(part, room), '')
  }

  if (commit.body.length > MAX_BODY_LINES) {
    line(`… ${commit.body.length - MAX_BODY_LINES} more lines`, ' opacity="0.7"')
  }

  const height = baseline - CARD_LINE + CARD_PAD

  return {
    markup:
      `<rect class="c" width="${width}" height="${height}" rx="6" fill="#000000" fill-opacity="0.85" stroke="#808080"/>` +
      texts.join(''),
    height,
  }
}

// The fills on the elements read on either theme by themselves; the style
// sharpens them, and marks a row under the pointer, where the surface keeps
// it. A card is shown and hidden by the drawing's own timing, no script: a
// click on its row begins it, a click anywhere off the card ends it.
const STYLE =
  '<style>:root{color-scheme:light dark}.t{fill:#1f2328}' +
  '.c{fill:#ffffff;fill-opacity:1;stroke:#d0d7de}' +
  '.h{cursor:pointer}.h:hover{fill-opacity:0.14}' +
  '@media (prefers-color-scheme:dark){.t{fill:#e6edf3}.c{fill:#2d333b;stroke:#545d68}}</style>'

// What a chunk's source holds beside its rows, and a card's own wrapping.
const FRAME_COST = 900
const PATH_COST = 40
const CARD_COST = 340

// The rows as drawings one under the other, each as many rows as fit an
// Svg's source. A line that crosses from one into the next is drawn in both,
// each cutting it at its edge, so stacked they read as one.
export const toChunks = (
  { rows, columns }: Layout,
  { width }: SvgOptions,
): Chunk[] => {
  const g = geometry(columns, width)
  const cardWidth = Math.max(120, Math.min(440, width - 2 * PAD))
  const cardX = round(Math.max(PAD, Math.min(g.textX, width - PAD - cardWidth)))
  const chunks: Chunk[] = []
  let from = 0

  while (from < rows.length) {
    const lines = new Map<number, string[]>()
    const marks: string[] = []
    const hits: string[] = []
    const cards: { index: number; markup: string; height: number }[] = []
    let size = FRAME_COST
    let to = from

    // Adds the lines to their colours' paths and answers what they cost: a
    // colour's own wrapping is written once a chunk.
    const draw = (edges: readonly Edge[], paths: readonly string[]): number => {
      let cost = 0

      edges.forEach((edge, index) => {
        const path = paths[index] ?? ''
        const drawn = lines.get(edge.color)

        if (drawn === undefined) {
          lines.set(edge.color, [path])
          cost += PATH_COST
        } else {
          drawn.push(path)
        }

        cost += path.length
      })

      return cost
    }

    const before = rows[from - 1]

    if (before !== undefined) {
      const paths = before.edges.map(edge =>
        edgePath(edge, -ROW / 2, ROW / 2, g, false),
      )
      size += draw(before.edges, paths)
    }

    while (to < rows.length) {
      const row = rows[to]

      if (row === undefined) {
        break
      }

      const index = to - from
      const top = index * ROW + ROW / 2
      const isOpen = to === rows.length - 1
      const paths = row.edges.map(edge =>
        edgePath(edge, top, isOpen ? top + ROW / 2 : top + ROW, g, isOpen),
      )
      const mark = rowMarks(row, top, g)
      const hit = `<rect id="h${index}" class="h" y="${index * ROW}" width="${width}" height="${ROW}" fill="#888888" fill-opacity="0"/>`
      const details = card(row.commit, cardWidth)
      const fresh = new Set(
        row.edges.map(edge => edge.color).filter(color => !lines.has(color)),
      )
      const cost =
        paths.join('').length +
        fresh.size * PATH_COST +
        mark.length +
        hit.length +
        details.markup.length +
        CARD_COST

      // A chunk holds one row at the least, whatever that row costs.
      if (to > from && size + cost > SOURCE_BUDGET) {
        break
      }

      draw(row.edges, paths)
      marks.push(mark)
      hits.push(hit)
      cards.push({ index, ...details })
      size += cost
      to += 1
    }

    const isFinal = to === rows.length
    const rowsHeight = (to - from) * ROW
    let height = rowsHeight

    // A card opens under its row, or over it where the chunk ends too soon;
    // the last chunk has nothing after it and may grow to hold one.
    const placed = cards.map(({ index, markup, height: tall }) => {
      const under = (index + 1) * ROW + 2
      const over = index * ROW - 2 - tall
      let y = under

      if (under + tall + 2 > rowsHeight) {
        if (over >= 2) {
          y = over
        } else if (isFinal) {
          height = Math.max(height, under + tall + 4)
        } else {
          y = Math.max(2, rowsHeight - tall - 2)
        }
      }

      return { index, markup, y }
    })

    const paths = [...lines.entries()].map(
      ([color, drawn]) => `<path d="${drawn.join('')}" stroke="${colorOf(color)}"/>`,
    )
    // One drawing cannot see a click on another: where the history is more
    // than one, a card is hidden too as the pointer leaves its own drawing.
    const leave = from === 0 && isFinal ? '' : ';s.mouseleave'
    // The backdrop lies over the row once its card is open, and for a moment
    // lets the pointer through, so a double click does not open and close it.
    const shown = placed.map(
      ({ index, markup, y }) =>
        `<g display="none"><set attributeName="display" to="inline" begin="h${index}.click" end="b${index}.click${leave}"/>` +
        `<rect id="b${index}" width="${width}" height="${height}" fill="#888888" fill-opacity="0">` +
        `<set attributeName="pointer-events" to="none" begin="h${index}.click" dur="0.4s"/></rect>` +
        `<g transform="translate(${cardX} ${y})">${markup}</g></g>`,
    )

    chunks.push({
      source:
        `<svg id="s" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
        `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif" font-size="${FONT}">` +
        STYLE +
        `<g fill="none" stroke-width="${g.stroke}" stroke-linecap="round">${paths.join('')}</g>` +
        marks.join('') +
        hits.join('') +
        shown.join('') +
        '</svg>',
      from,
      to,
      width,
      height,
    })
    from = to
  }

  return chunks
}

// One line a row, for a surface that draws no Svg.
export const toText = ({ rows, columns }: Layout): string[] =>
  rows.map(row => {
    let lanes = ''

    for (let column = 0; column < columns; column += 1) {
      if (column === row.column) {
        lanes += row.commit.isHead ? '◉ ' : '● '
      } else {
        lanes += row.passing.includes(column) ? '│ ' : '  '
      }
    }

    const refs = row.commit.refs.map(ref => `[${ref.name}] `).join('')

    return `${lanes}${refs}${row.commit.subject}`
  })

// The engine draws the first 100,000 characters of a tree's texts: the rows
// that fit well inside that, each cut to the pane's width.
export const TEXT_BUDGET = 80_000

export const fitText = (lines: readonly string[], columns: number): string[] => {
  const fitted: string[] = []
  let used = 0

  for (const line of lines) {
    const cut = clip(line, Math.max(20, columns))
    used += cut.length

    if (used > TEXT_BUDGET) {
      break
    }

    fitted.push(cut)
  }

  return fitted
}
