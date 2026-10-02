// ../../.config/opencode-v2/opencode/plugins/opencode-todo-fork/src/tui.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show } from "solid-js";

// ../../.config/opencode-v2/opencode/plugins/opencode-todo-fork/src/tui-data.ts
var STATUSES = ["pending", "in_progress", "completed", "cancelled"];
var PRIORITIES = ["high", "medium", "low"];
function normalizeTodos(input) {
  if (input === null || typeof input !== "object" || !("todos" in input)) {
    throw new Error("todowrite input requires a `todos` array");
  }
  const todos = input.todos;
  if (!Array.isArray(todos)) throw new Error("`todos` must be an array");
  return todos.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new Error(`todo #${index + 1} must be an object`);
    const item = entry;
    if (typeof item.content !== "string" || !item.content) throw new Error(`todo #${index + 1} needs content`);
    if (typeof item.status !== "string" || !STATUSES.includes(item.status)) {
      throw new Error(`todo #${index + 1} has invalid status`);
    }
    const todo = { content: item.content, status: item.status };
    if (typeof item.priority === "string" && PRIORITIES.includes(item.priority)) {
      todo.priority = item.priority;
    }
    return todo;
  });
}
function latestTodosFromMessages(messages) {
  if (!Array.isArray(messages)) return void 0;
  let latest;
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const tool = part;
      if (tool.type !== "tool" || tool.name !== "todowrite") continue;
      if (tool.state?.status !== "completed") continue;
      try {
        latest = normalizeTodos(tool.state.input);
      } catch {
      }
    }
  }
  return latest;
}
function headerLabel(todos) {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === "completed").length;
  const percent = total === 0 ? 0 : Math.round(done / total * 100);
  return `Todo [${done}/${total}] \xB7 ${percent}%`;
}

// ../../.config/opencode-v2/opencode/plugins/opencode-todo-fork/src/tui.tsx
var STATUS_MARK = {
  pending: "[ ]",
  in_progress: "[\u2022]",
  completed: "[x]",
  cancelled: "[-]"
};
function TodoRow(props) {
  const color = () => props.todo.status === "in_progress" ? props.context.theme.text.feedback.warning.base : props.todo.status === "completed" ? props.context.theme.text.muted : props.context.theme.text.base;
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "gap", 0);
    _$setProp(_el$2, "flexShrink", 0);
    _$insert(_el$2, () => `${STATUS_MARK[props.todo.status]} `);
    _$setProp(_el$3, "flexGrow", 1);
    _$setProp(_el$3, "wrapMode", "word");
    _$insert(_el$3, () => props.todo.content);
    _$effect((_p$) => {
      var _v$ = {
        fg: color()
      }, _v$2 = {
        fg: color()
      };
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "style", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "style", _v$2, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$;
  })();
}
function TodoStrip(props) {
  const todos = () => {
    try {
      return latestTodosFromMessages(props.context.data.session.message.list(props.sessionID)) ?? [];
    } catch {
      return [];
    }
  };
  const show = () => todos().length > 0 && todos().some((todo) => todo.status !== "completed");
  return _$createComponent(Show, {
    get when() {
      return show();
    },
    get children() {
      var _el$4 = _$createElement("box"), _el$5 = _$createElement("text"), _el$6 = _$createElement("b");
      _$insertNode(_el$4, _el$5);
      _$setProp(_el$4, "flexDirection", "column");
      _$setProp(_el$4, "gap", 0);
      _$setProp(_el$4, "paddingLeft", 1);
      _$setProp(_el$4, "paddingRight", 1);
      _$insertNode(_el$5, _el$6);
      _$insert(_el$6, () => headerLabel(todos()));
      _$insert(_el$4, _$createComponent(For, {
        get each() {
          return todos();
        },
        children: (todo) => _$createComponent(TodoRow, {
          get context() {
            return props.context;
          },
          todo
        })
      }), null);
      _$effect((_$p) => _$setProp(_el$5, "fg", props.context.theme.text.base, _$p));
      return _el$4;
    }
  });
}
var mod = {
  id: "aiev.todolist-fork.tui",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => _$createComponent(TodoStrip, {
        context,
        get sessionID() {
          return props.sessionID;
        }
      })
    });
  }
};
var tui_default = mod;
export {
  tui_default as default
};
