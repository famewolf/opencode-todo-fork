// Fork of opencode-todolist-local (MIT, aiev/opencode-todolist upstream).
// Adds: (1) a `/todo` server command that prints the session list on demand
// (completed marked, current task identified); (2) a TUI sidebar strip
// (see tui/index.js, built from src/tui.tsx).
//
// Kept from -local: session-scoped `ctx.storage` key `todos/${sessionID}`
// (same key auto-resume reads — no changes needed there), todowrite/todoread
// with identical schemas, best-effort OpenChamber context.json mirror on
// todowrite only, and NO per-request `ctx.session.hook("context")` injection.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const OPENCHAMBER_PROJECTS_DIR =
  process.env.OPENCHAMBER_PROJECTS_CONFIG_DIR ?? join(homedir(), ".config", "openchamber", "projects");

// Converts a status flag into OpenChamber's `completed` boolean.
function toChamberCompleted(status) {
  return status === "completed" || status === "cancelled";
}

// OpenChamber project context stem: `path_` + base64url of the project path
// (matches the `<stem>.json` / `<stem>/context.json` layout under projectsDir).
function projectStem(directory) {
  const b64 = Buffer.from(directory, "utf8").toString("base64url");
  return `path_${b64}`;
}

// Mirrors the session's todo list into OpenChamber's project context.json.
// Never throws: failures degrade to a stderr note only.
// Writes to BOTH the directory `path_` stem AND the session's projectID key
// (the latter is what the right-sidebar Context panel actually fetches).
async function mirrorTodosToOpenChamber(ctx, { sessionID, todos }) {
  try {
    let session = null;
    try {
      session = await ctx.session.get({ sessionID });
    } catch {
      session = await ctx.session.get(sessionID);
    }
    const info = session?.data ?? session;
    const directory = info?.location?.directory;
    if (!directory) return;

    // Candidate storage keys, in write order. projectID is the session-scoped
    // id the app uses for `/api/project-context/<projectId>`; the path_ stem is
    // the directory-derived project key. Both get the same mirror.
    const keys = new Set();
    if (typeof info?.projectID === "string" && info.projectID) keys.add(info.projectID);
    else if (typeof info?.project?.id === "string" && info.project.id) keys.add(info.project.id);
    keys.add(projectStem(directory));

    let existingTodos = [];
    let existingNotes = [];
    let existingPlans = [];
    try {
      const raw = await readFile(join(OPENCHAMBER_PROJECTS_DIR, projectStem(directory), "context.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.todos)) existingTodos = parsed.todos;
      if (Array.isArray(parsed?.notes)) existingNotes = parsed.notes;
      if (Array.isArray(parsed?.plans)) existingPlans = parsed.plans;
    } catch {
      // No file yet (or unreadable) -> start from empty state.
    }
    const now = Date.now();
    const existingByText = new Map(existingTodos.map((t) => [t.text, t]));
    const mirrored = todos.map((todo) => {
      const text = todo.content;
      const prior = existingByText.get(text);
      return {
        id: prior && typeof prior.id === "string" ? prior.id : `t_${createHash("sha1").update(text).digest("hex").slice(0, 10)}`,
        text,
        completed: toChamberCompleted(todo.status),
        createdAt: prior && typeof prior.createdAt === "number" ? prior.createdAt : now,
      };
    });
    const sessionTexts = new Set(todos.map((t) => t.content));
    const kept = existingTodos.filter((t) => !sessionTexts.has(t.text)); // user-added sidebar items
    const body = JSON.stringify(
      { version: 2, notes: existingNotes, todos: [...kept, ...mirrored], plans: existingPlans },
      null,
      2
    );
    for (const key of keys) {
      const contextPath = join(OPENCHAMBER_PROJECTS_DIR, key, "context.json");
      await mkdir(dirname(contextPath), { recursive: true });
      await writeFile(contextPath, body, "utf8");
    }
  } catch (err) {
    console.error(`[todo-fork] OpenChamber todo mirror skipped: ${err?.message ?? err}`);
  }
}

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"];
const TODO_PRIORITIES = ["high", "medium", "low"];
const STORAGE_PREFIX = "todos/";
// Deliberately NOT "[x]" / "1." prefixed lines: a markdown renderer turns
// `1. [x] text` into a task-list item and draws the number and the checkbox as
// UI, so the user sees neither in the rendered or copied output. Plain words
// with a two-space indent cannot be reinterpreted.
const STATUS_MARK = {
  pending: "OPEN ",
  in_progress: "DOING",
  completed: "DONE ",
  cancelled: "SKIP ",
};

function storageKey(sessionID) {
  return `${STORAGE_PREFIX}${sessionID}`;
}

/**
 * Canonical todo parser, mirroring this fork's own TUI reader
 * (src/tui-data.ts `latestTodosFromMessages`).
 *
 * The session MESSAGE LOG is the real store. Every `todowrite` call is persisted
 * as a tool part whose input carries the entire list, so the newest COMPLETED
 * call is the current list - which is exactly why "replace the list" needs no
 * storage layer at all, and why the TUI panel renders todos correctly.
 *
 * src/tui-data.ts holds the sibling copy because it is built separately for the
 * TUI bundle. If you change one, change both, or the panel and `/todo` will
 * disagree.
 */
// Order note: the endpoint returns newest-first; do not restore a
// last-match-wins loop here. See the comment inside for the [0/0] history.
export function todosFromMessages(messages) {
  if (!Array.isArray(messages)) return undefined;
  // Ordering: GET /api/session/{id}/message returns messages NEWEST FIRST
  // (measured against the live server 2026-10-03). The previous version took
  // the LAST completed match, which under that ordering is the OLDEST list -
  // /todo reported a stale 13-item list as "Todo [11/13]" while the live list
  // had 11 items. Rank explicitly by timestamp so array order is not load
  // bearing, then fall back to array order (newest-first).
  const candidates = [];
  let order = 0;
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      if (part.type !== "tool" || part.name !== "todowrite") continue;
      if (part.state?.status !== "completed") continue;
      const list = normalizeTodoList(part.state.input);
      // A malformed historical call is skipped, keeping the previous valid list.
      if (!list) continue;
      const t = part.state?.time ?? part.time ?? message.time ?? {};
      const at = [t.end, t.start, t.created].find((v) => typeof v === "number");
      candidates.push({ list, at: at ?? null, order: order++ });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    if (a.at !== null && b.at !== null && a.at !== b.at) return b.at - a.at;
    if ((a.at === null) !== (b.at === null)) return a.at === null ? 1 : -1;
    return a.order - b.order;
  });
  return candidates[0].list;
}

export function normalizeTodoList(input) {
  if (input === null || typeof input !== "object" || !Array.isArray(input.todos)) return undefined;
  const out = [];
  for (const entry of input.todos) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.content !== "string" || typeof entry.status !== "string") continue;
    const todo = { content: entry.content, status: entry.status };
    if (typeof entry.priority === "string") todo.priority = entry.priority;
    out.push(todo);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Every plausible source of a session's messages, tried in order.
 *
 * Returns undefined - never [] - when no source produced anything, so "no todos
 * exist" stays distinguishable from "we could not look". That distinction is
 * what keeps this diagnosable instead of silently reporting [0/0].
 *
 * Source 3 (`ctx.storage`) is a FALLBACK ONLY. It is a v1-shaped key that
 * nothing in v2 writes, so it always misses.
 */
export async function todosFromMessageSources(ctx, sessionID) {
  try {
    const list = ctx?.client?.session?.message?.list;
    if (typeof list === "function") {
      const res = await list.call(ctx.client.session.message, { path: { id: sessionID } });
      const got = todosFromMessages(res?.data ?? res);
      if (got) return got;
    }
  } catch {
    // fall through to HTTP
  }
  for (const base of serverBaseUrls()) {
    try {
      // `limit` matters: the default page is 50 messages. 200 is the server's
      // ceiling (probed: limit=250 -> 400). Newest first, so a recent todowrite
      // is always inside the page.
      const res = await fetch(`${base}/api/session/${encodeURIComponent(sessionID)}/message?limit=200`, { headers: serverHeaders() });
      if (!res.ok) continue;
      // The server wraps the page in an ENVELOPE - {data:[...], cursor:{...}} -
      // and never returns a bare array. Handing the envelope to todosFromMessages
      // trips its Array.isArray guard and yields undefined, which is why this
      // source silently resolved nothing. Unwrap `data`.
      const body = await res.json();
      const got = todosFromMessages(body?.data ?? body);
      if (got) return got;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Candidate local server base URLs: env vars first, then /proc/self/cmdline.
 *  `cmdline` is injectable so the port parsing is unit-testable without
 *  spawning a process whose argv looks like a server invocation. */
export function serverBaseUrls(cmdline) {
  const env = process.env;
  const out = [];
  const push = (v) => {
    if (typeof v !== "string" || !v) return;
    const url = v.startsWith("http") ? v : `http://127.0.0.1:${v.replace(/^:/, "")}`;
    if (!out.includes(url)) out.push(url.replace(/\/$/, ""));
  };
  push(env.OPENCODE_SERVER_URL);
  push(env.OPENCODE_URL);
  push(env.OPENCODE_SERVER_PORT);
  push(env.OPENCODE_PORT);
  push(env.PORT);

  // Env vars alone are NOT enough under OpenChamber. The server is spawned as
  // `opencode serve --hostname 127.0.0.1 --port <n>` and exports no port env var,
  // so the candidate list above comes back EMPTY, this HTTP source is never
  // attempted, and the caller silently falls through to the dead ctx.storage
  // key - which is exactly how /todo came to print [0/0] with 14 todos in the
  // message log. Same /proc/self/cmdline mechanism the prompt-polisher uses,
  // which is why its HTTP DELETE works against this same server.
  try {
    const raw = cmdline ?? readFileSync("/proc/self/cmdline", "utf8");
    const argv = raw.split("\0");
    const portFlag = argv.indexOf("--port");
    if (portFlag !== -1 && argv[portFlag + 1]) {
      const hostFlag = argv.indexOf("--hostname");
      const host = hostFlag !== -1 && argv[hostFlag + 1] ? argv[hostFlag + 1] : "127.0.0.1";
      push(`http://${host}:${argv[portFlag + 1]}`);
    }
  } catch {
    // /proc unavailable (non-Linux): env vars only
  }
  return out;
}

/** HTTP Basic for the local server, same derivation the prompt-polisher uses. */
export function serverHeaders() {
  const pw = process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_PASSWORD;
  if (!pw) return {};
  return { Authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` };
}

function normalizeTodos(input) {
  if (input === null || typeof input !== "object" || !("todos" in input)) {
    throw new Error("todowrite requires a `todos` array");
  }
  const todos = input.todos;
  if (!Array.isArray(todos)) {
    throw new Error("`todos` must be an array");
  }
  return todos.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`todo #${index + 1} must be an object`);
    }
    const item = entry;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) {
      throw new Error(`todo #${index + 1} requires a non-empty \`content\` string`);
    }
    if (!TODO_STATUSES.includes(item.status)) {
      throw new Error(`todo #${index + 1} has invalid \`status\` (expected one of: ${TODO_STATUSES.join(", ")})`);
    }
    const todo = { content, status: item.status };
    if (item.priority !== undefined) {
      if (!TODO_PRIORITIES.includes(item.priority)) {
        throw new Error(`todo #${index + 1} has invalid \`priority\` (expected one of: ${TODO_PRIORITIES.join(", ")})`);
      }
      todo.priority = item.priority;
    }
    return todo;
  });
}

export function renderTodos(todos) {
  if (!Array.isArray(todos) || todos.length === 0) {
    return "  (the todo list is empty)";
  }
  const width = String(todos.length).length;
  return todos
    .map((todo, index) => {
      const tag = STATUS_MARK[todo.status] ?? "?????";
      const priority = todo.priority ? ` [${todo.priority}]` : "";
      return `  ${tag} ${String(index + 1).padStart(width, " ")}. ${todo.content}${priority}`;
    })
    .join("\n");
}

// On-demand report for /todo: counts, current task, full list.
export function renderTodoReport(todos) {
  if (!Array.isArray(todos) || todos.length === 0) {
    return "Todo [0/0]: the todo list is empty.";
  }
  const done = todos.filter((t) => t.status === "completed").length;
  const open = todos.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  const current = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
  const currentLine = current
    ? `Current task: ${current.content}`
    : "Current task: none - every item is completed or cancelled.";
  return `Todo [${done}/${todos.length}] - ${open} open\n${currentLine}\n${renderTodos(todos)}`;
}

function parseTodoRecord(value) {
  if (value === null || typeof value !== "object") return undefined;
  const stored = value;
  if (!Array.isArray(stored.todos)) return undefined;
  const todos = [];
  for (const entry of stored.todos) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry;
    if (typeof item.content !== "string" || !TODO_STATUSES.includes(item.status)) continue;
    const todo = { content: item.content, status: item.status };
    if (TODO_PRIORITIES.includes(item.priority)) {
      todo.priority = item.priority;
    }
    todos.push(todo);
  }
  return { todos, updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : 0 };
}

const TODOS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The complete todo list. This replaces any previous list.",
      items: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Imperative description of the task.",
          },
          status: {
            type: "string",
            enum: [...TODO_STATUSES],
            description: "Current state of the task.",
          },
          priority: {
            type: "string",
            enum: [...TODO_PRIORITIES],
            description: "Optional priority of the task.",
          },
        },
        required: ["content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
};

const TODO_READ_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const TODOWRITE_DESCRIPTION = [
  "Create or replace the session todo list.",
  "Pass the complete list every time; it replaces any previous one.",
  "Use it to plan multi-step work and keep status current: keep exactly one task in_progress while working on it,",
  "mark tasks completed as soon as they are done, and cancel tasks that are no longer needed.",
  "Prefer short, imperative task descriptions.",
].join(" ");

const TODOREAD_DESCRIPTION =
  "Read the current session todo list. Use it to recover the list after context compaction or to check progress before starting the next task.";

const TODO_COMMAND_DESCRIPTION =
  "Show the current session todo list: completed items marked, current task identified. Same list the todowrite/todoread tools manage.";

const plugin = {
  id: "aiev.todolist-fork",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "todowrite",
        description: TODOWRITE_DESCRIPTION,
        input: TODOS_INPUT_SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => {
          const todos = normalizeTodos(input);
          await ctx.storage.set(storageKey(context.sessionID), { todos, updatedAt: Date.now() });
          // Best-effort bridge to OpenChamber's right-sidebar Todo tab. Never throws.
          await mirrorTodosToOpenChamber(ctx, { sessionID: context.sessionID, todos });
          return {
            content: `Todo list updated (${todos.length} ${todos.length === 1 ? "item" : "items"}):\n${renderTodos(todos)}`,
          };
        },
      });
      editor.add({
        name: "todoread",
        description: TODOREAD_DESCRIPTION,
        input: TODO_READ_INPUT_SCHEMA,
        options: { codemode: false },
        execute: async (_input, context) => {
          const record = parseTodoRecord(await ctx.storage.get(storageKey(context.sessionID)));
          const todos = record?.todos ?? [];
          return { content: `Current todo list:\n${renderTodos(todos)}` };
        },
      });
    });
    await ctx.command.transform((editor) => {
      editor.add({
        name: "todo",
        description: TODO_COMMAND_DESCRIPTION,
        execute: async ({ sessionID, prompt, delivery }) => {
          // Read from the session message log first - see todosFromMessages().
          // ctx.storage is the v1 fallback and is expected to miss.
          let todos = await todosFromMessageSources(ctx, sessionID);
          if (!todos) {
            const record = parseTodoRecord(await ctx.storage?.get(storageKey(sessionID)));
            todos = record?.todos ?? [];
          }
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: renderTodoReport(todos),
            delivery,
          });
        },
      });
    });
  },
};

export default plugin;
