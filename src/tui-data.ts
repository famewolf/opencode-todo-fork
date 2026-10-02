/** Minimal todo types + normalization for the TUI strip (adapted from
 * aiev/opencode-todolist src/todos.ts; MIT). The strip has no access to plugin
 * storage, so it rebuilds the list from tool inputs found in messages. */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type Todo = {
  content: string;
  status: TodoStatus;
  priority?: "high" | "medium" | "low";
};

const STATUSES: ReadonlyArray<string> = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITIES: ReadonlyArray<string> = ["high", "medium", "low"];

export function normalizeTodos(input: unknown): Array<Todo> {
  if (input === null || typeof input !== "object" || !("todos" in input)) {
    throw new Error("todowrite input requires a `todos` array");
  }
  const todos = (input as { todos: unknown }).todos;
  if (!Array.isArray(todos)) throw new Error("`todos` must be an array");
  return todos.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new Error(`todo #${index + 1} must be an object`);
    const item = entry as { content?: unknown; status?: unknown; priority?: unknown };
    if (typeof item.content !== "string" || !item.content) throw new Error(`todo #${index + 1} needs content`);
    if (typeof item.status !== "string" || !STATUSES.includes(item.status)) {
      throw new Error(`todo #${index + 1} has invalid status`);
    }
    const todo: Todo = { content: item.content, status: item.status as TodoStatus };
    if (typeof item.priority === "string" && PRIORITIES.includes(item.priority)) {
      todo.priority = item.priority as Todo["priority"];
    }
    return todo;
  });
}

type ToolPart = {
  type?: unknown;
  name?: unknown;
  state?: { status?: unknown; input?: unknown } | undefined;
};

/**
 * Scans session messages for the most recent completed `todowrite` call and
 * returns its normalized list. Used by the TUI strip, which has no access to
 * the plugin storage.
 */
export function latestTodosFromMessages(messages: ReadonlyArray<unknown> | undefined): Array<Todo> | undefined {
  if (!Array.isArray(messages)) return undefined;
  let latest: Array<Todo> | undefined;
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const tool = part as ToolPart;
      if (tool.type !== "tool" || tool.name !== "todowrite") continue;
      if (tool.state?.status !== "completed") continue;
      try {
        latest = normalizeTodos(tool.state.input);
      } catch {
        // Keep the previous valid list when a historical call is malformed.
      }
    }
  }
  return latest;
}

/** Strip heading: `Todo [done/total] · NN%`. */
export function headerLabel(todos: ReadonlyArray<Todo>): string {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === "completed").length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return `Todo [${done}/${total}] · ${percent}%`;
}
