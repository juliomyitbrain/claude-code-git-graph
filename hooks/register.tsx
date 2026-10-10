import type { EngineInterface, Register } from 'claude-code'

import {
  clip,
  fitText,
  layout,
  logArgv,
  parseLog,
  toChunks,
  toText,
} from './graph'
import type { Chunk, Layout } from './graph'

const PANE = 'git-graph'
const TITLE = 'Git graph'
const PAGE = 150
const MAX_COMMITS = 1500
// A cell of the pane's body in CSS pixels, near enough to size the drawing.
const CELL = 7.5

type Loaded =
  | { kind: 'graph'; graph: Layout; hasMore: boolean }
  | { kind: 'empty'; reason: string }

const read = async (
  $: EngineInterface,
  limit: number,
  withBody = true,
): Promise<Loaded> => {
  let ran

  try {
    ran = await $.process.run(logArgv(limit + 1, withBody))
  } catch {
    return { kind: 'empty', reason: 'git could not be run here.' }
  }

  if (ran.exitCode !== 0) {
    if (/not a git repository/i.test(ran.stderr)) {
      return { kind: 'empty', reason: 'This folder is not a git repository.' }
    }

    if (/does not have any commits yet/i.test(ran.stderr)) {
      return { kind: 'empty', reason: 'No commits yet.' }
    }

    const [line = ''] = ran.stderr.trim().split('\n')

    return { kind: 'empty', reason: line === '' ? 'git log failed.' : line }
  }

  const commits = parseLog(ran.stdout)

  // The engine hands over the first 4 MiB of what git wrote: messages long
  // enough to pass it leave the read short of its commits. The rows are then
  // read again without the messages, and keep those the cut read held.
  if (ran.isStdoutTruncated && withBody) {
    const whole = await read($, limit, false)

    if (whole.kind === 'graph') {
      const bodies = new Map(commits.map(commit => [commit.hash, commit.body]))

      for (const { commit } of whole.graph.rows) {
        commit.body = bodies.get(commit.hash) ?? []
      }
    }

    return whole
  }

  if (commits.length === 0) {
    return {
      kind: 'empty',
      reason: ran.isStdoutTruncated
        ? 'git log wrote more than can be read here.'
        : 'No commits yet.',
    }
  }

  return {
    kind: 'graph',
    graph: layout(commits.slice(0, limit)),
    hasMore: commits.length > limit,
  }
}

// What the pane last read and drew, kept until something may have moved it.
let limit = PAGE
let loaded: Loaded | null = null
let drawing: { width: number; chunks: Chunk[] } | null = null
// Counts the refreshes, so a read one of them overtook is known to be stale.
let epoch = 0

const refresh = ($: EngineInterface): void => {
  epoch += 1
  loaded = null
  drawing = null
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-graph',
      description: 'Show the commit graph of this repository in a pane',
    })

    return next(e)
  })

  on('command.run', { command: 'git-graph' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    refresh($)

    return {
      text: opened.isPlaced
        ? 'Git graph pane opened.'
        : `Git graph pane is open but not drawn: ${opened.reason}`,
    }
  })

  // A git or gh command the session ran may have moved the graph.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)

    if (/\b(git|gh)\b/.test(e.command)) {
      refresh($)
    }

    return ran
  })

  // So may a turn's end (a command left in the background, a commit made
  // elsewhere meanwhile) and a move to another folder.
  on('turn.complete', ($, e, next) => {
    refresh($)

    return next(e)
  })

  on('classic.CwdChanged', ($, e, next) => {
    refresh($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    let now = loaded

    while (now === null) {
      const asked = epoch
      const fresh = await read($, limit)

      // A refresh while git log ran: what it read is neither kept nor drawn.
      if (asked === epoch) {
        loaded ??= fresh
      }

      now = loaded
    }

    if (now.kind === 'empty') {
      const { Box, Button, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{now.reason}</Text>
          <Box>
            <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          </Box>
        </Box>
      )
    }

    const total = now.graph.rows.length
    const canGrow = now.hasMore && limit < MAX_COMMITS
    const cells = Number.isFinite(e.props.bodyColumns) ? e.props.bodyColumns : 56
    const showMore = (): void => {
      limit = Math.min(MAX_COMMITS, limit + PAGE)
      refresh($)
    }

    if (e.surface === 'terminal') {
      const { Box, Button, Text } = $.ui.resolve(e)
      const lines = fitText(toText(now.graph), cells)

      // The button stands above the rows: what a tree draws past its budget
      // of text is cut from the end.
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text dimColor>
              {lines.length} commits
              {lines.length < total ? ' (as many as one pane holds)' : ''}
            </Text>
            <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
            {canGrow && lines.length === total && (
              <Button key="more" label="Show more" onPress={showMore} />
            )}
          </Box>
          {lines.map(line => (
            <Text wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )
    }

    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    const width = Math.round(Math.max(320, Math.min(1000, cells * CELL)))

    if (drawing === null || drawing.width !== width) {
      drawing = { width, chunks: toChunks(now.graph, { width }) }
    }

    const head = now.graph.rows.find(row => row.commit.isHead)

    // Each chunk is drawn interactive: a click on a commit opens the card of
    // its details that the drawing itself holds, and no hook runs for it.
    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1} alignItems="center">
          <Text dimColor>{total} commits, click one for its details</Text>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
        <Box flexDirection="column">
          {drawing.chunks.map((chunk, index) => (
            <Svg
              isInteractive
              source={chunk.source}
              alt={
                index === 0
                  ? `Commit graph of ${total} commits${
                      head === undefined
                        ? ''
                        : `, HEAD at "${clip(head.commit.subject, 100)}"`
                    }.`
                  : `Commits ${chunk.from + 1} to ${chunk.to}.`
              }
            />
          ))}
        </Box>
        {canGrow && (
          <Box>
            <Button key="more" label="Show more" onPress={showMore} />
          </Box>
        )}
      </Box>
    )
  })
}
