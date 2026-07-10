# pi-ask-herdr

A Pi extension that adds an `askuser` tool, with optional integration with
[Herdr](https://herdr.dev) notifications and agent state.

## What it does

- Registers an `askuser` tool that can ask the user for:
  - free-form text (`type: "text"`)
  - yes/no confirmation (`type: "confirm"`)
  - single choice from a list (`type: "select"`)
  - multiple choices from a list (`type: "multiselect"`)
- Waits for the answer and returns it to the agent.
- For `select` and `multiselect`, an **"Other (custom)"** option is always
  available so the user can type their own answer.
- For `confirm`, you can enable the same custom option with
  `"allow_custom": true`.
- No extra slash command is registered — only the `askuser` tool.
- When Pi runs inside a Herdr pane, it:
  - reports the pane state as `blocked` while waiting
  - sends a Herdr toast notification so the user knows input is needed
  - restores the pane state after the user answers

## Install

Copy or clone this directory into Pi's extensions folder:

```bash
# Global
cp -R pi-ask-herdr ~/.pi/agent/extensions/

# Or project-local
cp -R pi-ask-herdr .pi/extensions/
```

Then reload Pi with `/reload`, or test it directly with:

```bash
pi -e ~/.pi/agent/extensions/pi-ask-herdr/index.ts
```

## Tool usage

```json
{
  "question": "Which database should we use?",
  "type": "select",
  "options": ["PostgreSQL", "SQLite", "MySQL"]
}
```

### Parameters

| Name      | Type     | Required | Description                                      |
|-----------|----------|----------|--------------------------------------------------|
| question  | string   | yes      | The question to display                          |
| type         | string   | no       | `"text"`, `"confirm"`, `"select"`, `"multiselect"` (default: text) |
| options      | string[] | no       | Required when `type` is `select` or `multiselect`            |
| default      | string   | no       | Prefilled value for text input                               |
| timeout      | number   | no       | Auto-cancel after N milliseconds                             |
| allow_custom | boolean  | no       | For `confirm`: also offer "Other (custom)"                   |

## Herdr integration

The extension detects Herdr via the environment variables that Herdr injects
into its panes:

- `HERDR_ENV=1`
- `HERDR_SOCKET_PATH`
- `HERDR_PANE_ID`

If these are present, the extension calls:

- `pane.report_agent` with state `blocked` before prompting
- `notification.show` with the question as the body
- `pane.report_agent` with state `working` (or `idle` if cancelled) afterwards

No extra configuration is required.

## License

MIT
