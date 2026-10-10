# git-graph

A Claude Code mod that draws the commit graph of the session's repository in a pane: lanes, merge curves, and branch and tag labels.

## Install

At the prompt of a terminal `claude` session:

```
/plugin install git-graph --marketplace juliomyitbrain/claude-code-git-graph
```

Answer `y` to add the marketplace, then choose the user scope. The mod then loads in every new session on that machine, including sessions the desktop app starts there.

It needs a Claude Code build that supports mods (function hooks); it was built and tested on 2.1.293 and 2.1.295.

## Use

Type `/git-graph` in a session opened on a git repository.

- The pane shows the latest 150 commits across all branches, remote branches and tags; **Show more** adds 150 at a time, up to 1,500.
- Click a commit to open a card with its full hash, author, date, ref names, whole subject and the first lines of its message. Click anywhere off the card to close it.
- The graph reloads after the session runs a `git` or `gh` command, at the end of each turn, and when the session changes folder. **Refresh** reloads it by hand.
- In a terminal the graph is a plain-text fallback without cards.

## Develop

```
claude plugin validate .
claude plugin test .
```

`hooks/graph.ts` holds the logic that needs no engine (parsing `git log`, laying out lanes, drawing the SVG); `hooks/register.tsx` holds the hooks.
