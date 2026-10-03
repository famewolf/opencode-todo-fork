// Tests for the message-log reader.
//
// These exist because the ranking is not obvious from the code and a wrong
// version of it already shipped once: GET /api/session/{id}/message returns
// messages NEWEST FIRST, so the previous parser - which took the last completed
// match - selected the OLDEST list and reported a stale count.
//
// Run with: node --test tests/

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  todosFromMessages,
  normalizeTodoList,
  renderTodoReport,
  renderTodos,
} from "../index.js"

/** Build one assistant message carrying a completed `todowrite` tool part. */
const write = (todos, { created = 1000, status = "completed", stateTime } = {}) => ({
  time: { created },
  content: [
    {
      type: "tool",
      name: "todowrite",
      state: {
        status,
        ...(stateTime ? { time: { end: stateTime } } : {}),
        input: { todos },
      },
    },
  ],
})

const item = (content, status = "pending") => ({ content, status, priority: "high" })

// --- the bug that already shipped: newest-first ordering --------------------

test("picks the NEWEST completed list, not the oldest", () => {
  const oldest = write([item("old")], { created: 1000 })
  const middle = write([item("mid")], { created: 2000 })
  const newest = write([item("new")], { created: 3000 })

  // The endpoint hands these back newest first, so array order is the REVERSE
  // of chronological order. A last-match-wins parser would return "old" here.
  const got = todosFromMessages([newest, middle, oldest])
  assert.deepEqual(got?.map((t) => t.content), ["new"])
})

test("array order does not change the answer when timestamps are present", () => {
  const older = write([item("older")], { created: 1000 })
  const newer = write([item("newer")], { created: 3000 })
  const mid = write([item("mid")], { created: 2000 })

  assert.deepEqual(todosFromMessages([older, newer, mid])?.map((t) => t.content), ["newer"])
  assert.deepEqual(todosFromMessages([newer, older, mid])?.map((t) => t.content), ["newer"])
  assert.deepEqual(todosFromMessages([mid, newer, older])?.map((t) => t.content), ["newer"])
})

test("falls back to array order when no candidate carries a timestamp", () => {
  const a = write([item("a")], { created: 1000 })
  const b = write([item("b")], { created: 2000 })
  for (const m of [a, b]) delete m.time

  // Under newest-first array order the FIRST candidate is the newest, and with
  // no timestamp to rank on that is the only thing left to go by.
  assert.deepEqual(todosFromMessages([b, a])?.map((t) => t.content), ["b"])
})

test("prefers state.time over the enclosing message time when both exist", () => {
  const a = write([item("a")], { created: 9000, stateTime: 1000 })
  const b = write([item("b")], { created: 1000, stateTime: 9000 })

  assert.deepEqual(todosFromMessages([a, b])?.map((t) => t.content), ["b"])
})

// --- filtering ---------------------------------------------------------------

test("ignores a todowrite part that is not completed", () => {
  const failed = write([item("failed write")], { created: 3000, status: "error" })
  const ok = write([item("good")], { created: 1000 })

  assert.deepEqual(todosFromMessages([failed, ok])?.map((t) => t.content), ["good"])
})

test("skips a malformed call and keeps the previous valid list", () => {
  const broken = {
    time: { created: 3000 },
    content: [
      { type: "tool", name: "todowrite", state: { status: "completed", input: { todos: "nope" } } },
    ],
  }
  const ok = write([item("good")], { created: 1000 })

  assert.deepEqual(todosFromMessages([broken, ok])?.map((t) => t.content), ["good"])
})

test("ignores other tools and non-tool parts", () => {
  const other = {
    time: { created: 3000 },
    content: [
      { type: "tool", name: "todowrite", state: { status: "completed", input: { todos: "nope" } } },
      { type: "tool", name: "todowrite_alt", state: { status: "completed", input: { todos: [] } } },
      { type: "text", text: "hello" },
      { type: "tool", name: "todowrite", state: { status: "completed", input: { todos: [item("real")] } } },
    ],
  }
  assert.deepEqual(todosFromMessages([other])?.map((t) => t.content), ["real"])
})

test("tolerates null and non-object entries in the array", () => {
  const ok = write([item("good")], { created: 1000 })
  assert.deepEqual(todosFromMessages([null, 42, "x", undefined, ok])?.map((t) => t.content), [
    "good",
  ])
})

test("a message with no content array is skipped, not fatal", () => {
  assert.equal(todosFromMessages([{ time: { created: 1 } }, null]), undefined)
})

// --- undefined vs [] : the distinction /todo's diagnosability rests on -------

test("returns undefined, never [], when there is no list at all", () => {
  assert.equal(todosFromMessages([]), undefined)
  assert.equal(todosFromMessages(undefined), undefined)
  assert.equal(todosFromMessages("not an array"), undefined)
  assert.equal(todosFromMessages([write([], { created: 1 })]), undefined)
})

// --- normalizeTodoList -------------------------------------------------------

test("normalizeTodoList accepts the todowrite input shape", () => {
  assert.deepEqual(normalizeTodoList({ todos: [item("a", "in_progress")] }), [
    item("a", "in_progress"),
  ])
})

test("normalizeTodoList rejects anything that is not a list of todo items", () => {
  for (const bad of [undefined, null, {}, { todos: "x" }, { todos: [null] }, { todos: [{ x: 1 }] }, 7]) {
    assert.equal(normalizeTodoList(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`)
  }
})

// --- rendering: what the numbers in "Todo [0/9]" actually mean ---------------

test("renderTodoReport counts COMPLETED of total, not open of total", () => {
  const report = renderTodoReport([
    item("done one", "completed"),
    item("done two", "completed"),
    item("still open"),
  ])
  assert.match(report, /^Todo \[2\/3\]/)
  assert.match(report, /1 open/)
})

test("renderTodoReport on an empty list is distinguishable from a failed read", () => {
  assert.match(renderTodoReport([]), /empty/)
})

test("renderTodoReport names the in-progress item as the current task", () => {
  const report = renderTodoReport([item("queued"), item("busy", "in_progress")])
  assert.match(report, /Current task: busy/)
})

test("renderTodoReport says so when nothing is open", () => {
  const report = renderTodoReport([item("finished", "completed")])
  assert.match(report, /Current task: none/)
})

test("renderTodos marks each status distinctly", () => {
  const out = renderTodos([
    item("a", "pending"),
    item("b", "in_progress"),
    item("c", "completed"),
    item("d", "cancelled"),
  ])
  assert.match(out, /OPEN/)
  assert.match(out, /DOING/)
  assert.match(out, /DONE/)
  assert.match(out, /SKIP/)
})
