# opencode-todo-fork

Session todo tools (`todowrite` / `todoread`) plus a `/todo` server command and
a TUI sidebar strip. Fork of `opencode-todolist-local` (MIT, upstream
`aiev/opencode-todolist`). No per-request context-hook injection.

## Commands and tools

| Name | Kind | Behavior |
|---|---|---|
| `todowrite` | tool | Replaces the whole list. Writes `ctx.storage` key `todos/<sessionID>` (`{ todos, updatedAt }`) and mirrors to OpenChamber's project `context.json` (best-effort, never throws). |
| `todoread` | tool | Reads the list back from this plugin's own storage key. |
| `/todo` | command | Prints the session list on demand (`Todo [done/total]`, completed marked, in-progress item named as current task). |

Sample output (live):

```
Todo [0/2] - 2 open
Current task: Verify /todo shows this list after server restart
  DOING 1. Verify /todo shows this list after server restart
  OPEN  2. Report round-trip result to user
```

## How `/todo` reads the list

The session **message log** is the real store: every `todowrite` call persists
as a tool part whose input carries the entire list, so the newest *completed*
call is the current list. Sources, in order:

1. `ctx.client.session.message.list`, when the host offers it.
2. `GET /api/session/<id>/message?limit=200` over loopback (200 is the
   server's page ceiling; the endpoint answers `{ data, cursor }`, never a
   bare array).
3. `ctx.storage` fallback — same-plugin writes only. `ctx.storage` is
   **namespaced per plugin** (`storage/plugin/<PLUGIN-ID>/<key>.json`), so a
   list written by any other todo tool lives in that tool's namespace and
   still misses here. The message log is the only store every writer agrees on.

`todosFromMessages()` keeps the normalized input of every completed
`todowrite` part and ranks by timestamp (message `time.created`; tool parts
carry no timestamp of their own), so array order is not load-bearing:
`/api/session/{id}/message` answers newest-first, and a last-match-wins loop
would select the oldest list. Malformed historical calls are skipped. Returns
`undefined` — never `[]` — when no source produced anything, so "no todos
exist" stays distinguishable from "could not look".

The TUI strip (`tui/`, built from `src/tui.tsx` via `src/tui-data.ts`
`latestTodosFromMessages`) holds the sibling copy of this parser. Change one,
change both, or the panel and `/todo` will disagree.

## Tests

```
npm test   # node --test tests/ — 17 tests: ranking, malformed-call
           # tolerance, envelope unwrap, report rendering
```

## Deploying

The server loads plugin code at startup: after updating the installed copy,
restart `opencode serve` (a running server keeps executing the pre-update
code, which reads storage-only and prints `[0/0]` for lists that live only in
the message log).

## License

MIT (inherited from upstream).
