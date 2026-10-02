/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";
import type { Todo } from "./tui-data.js";
import { headerLabel, latestTodosFromMessages } from "./tui-data.js";

const STATUS_MARK: Record<Todo["status"], string> = {
  pending: "[ ]",
  in_progress: "[•]",
  completed: "[x]",
  cancelled: "[-]",
};

function TodoRow(props: { context: Plugin.Context; todo: Todo }) {
  const color = () =>
    props.todo.status === "in_progress"
      ? props.context.theme.text.feedback.warning.base
      : props.todo.status === "completed"
        ? props.context.theme.text.muted
        : props.context.theme.text.base;

  return (
    <box flexDirection="row" gap={0}>
      <text flexShrink={0} style={{ fg: color() }}>
        {`${STATUS_MARK[props.todo.status]} `}
      </text>
      <text flexGrow={1} wrapMode="word" style={{ fg: color() }}>
        {props.todo.content}
      </text>
    </box>
  );
}

/** Session todo list at the end of the sidebar. Hidden when the list is empty
 * or fully completed — the `/todo` command still shows it on demand. */
function TodoStrip(props: { context: Plugin.Context; sessionID: string }) {
  const todos = () => {
    try {
      return latestTodosFromMessages(props.context.data.session.message.list(props.sessionID)) ?? [];
    } catch {
      return [];
    }
  };
  const show = () => todos().length > 0 && todos().some((todo) => todo.status !== "completed");

  return (
    <Show when={show()}>
      <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1}>
        <text fg={props.context.theme.text.base}>
          <b>{headerLabel(todos())}</b>
        </text>
        <For each={todos()}>{(todo) => <TodoRow context={props.context} todo={todo} />}</For>
      </box>
    </Show>
  );
}

const mod: Plugin.Definition = {
  id: "aiev.todolist-fork.tui",

  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <TodoStrip context={context} sessionID={props.sessionID} />,
    });
  },
};

export default mod;
