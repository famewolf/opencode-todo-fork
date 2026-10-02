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
const STATUS_MARK = {
  pending: "[ ]",
  in_progress: "[•]",
  completed: "[x]",
  cancelled: "[-]",
};

function storageKey(sessionID) {
  return `${STORAGE_PREFIX}${sessionID}`;
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

function renderTodos(todos) {
  if (todos.length === 0) {
    return "(the todo list is empty)";
  }
  return todos
    .map((todo, index) => {
      const priority = todo.priority ? ` — ${todo.priority} priority` : "";
      return `${index + 1}. ${STATUS_MARK[todo.status]} ${todo.content}${priority}`;
    })
    .join("\n");
}

// On-demand report for /todo: counts, current task, full list.
function renderTodoReport(todos) {
  if (todos.length === 0) {
    return "Todo [0/0]: the todo list is empty.";
  }
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
  const currentLine = current ? `Current task: ${current.content}` : "Current task: none (all items completed or cancelled).";
  return `Todo [${done}/${todos.length}]\n${currentLine}\n${renderTodos(todos)}`;
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
          const record = parseTodoRecord(await ctx.storage.get(storageKey(sessionID)));
          const todos = record?.todos ?? [];
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
