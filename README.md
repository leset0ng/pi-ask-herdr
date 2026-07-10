# pi-ask-herdr

A Pi extension that adds an `ask_user` tool, with optional integration with
[Herdr](https://herdr.dev) notifications and agent state.

## Structure

```text
index.ts      # Pi auto-discovery entry point
src/
  tool.ts     # Tool registration and parameter schema
  ui.ts       # TUI prompts (text, confirm, select, multiselect)
  herdr.ts    # Herdr socket / event-bus integration
  options.ts  # Option normalization and display formatting
  types.ts    # Shared TypeScript types
```

## What it does

- Registers an `ask_user` tool that can ask the user for:
  - free-form text (`type: "text"`)
  - yes/no confirmation (`type: "confirm"`)
  - single choice from a list (`type: "select"`)
  - multiple choices from a list (`type: "multiselect"`)
- Waits for the answer and returns it to the agent.
- For `select` and `multiselect`, an **"Other (custom)"** option is always
  available so the user can type their own answer.
- For `confirm`, you can enable the same custom option with
  `"allow_custom": true`.
- No extra slash command is registered — only the `ask_user` tool.
- When Pi runs inside a Herdr pane, it:
  - reports the pane state as `blocked` while waiting
  - sends a Herdr toast notification so the user knows input is needed
  - restores the pane state after the user answers

## Install

### From npm (recommended)

```bash
pi install npm:pi-ask-herdr
```

Then reload Pi with `/reload`.

### From git

```bash
pi install git:github.com/leset0ng/pi-ask-herdr@v0.1.0
```

### Manual

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

Simple string options:

```json
{
  "question": "Which database should we use?",
  "type": "select",
  "options": ["PostgreSQL", "SQLite", "MySQL"]
}
```

Options with descriptions:

```json
{
  "question": "Which database should we use?",
  "type": "select",
  "options": [
    { "label": "PostgreSQL", "description": "Full-featured relational database" },
    { "label": "SQLite", "description": "Zero-config file database" },
    { "label": "MySQL", "description": "Widely used open-source RDBMS" }
  ]
}
```

### Parameters

| Name         | Type                 | Required | Description                                      |
|--------------|----------------------|----------|--------------------------------------------------|
| question     | string               | yes      | The question to display                          |
| type         | string               | no       | `"text"`, `"confirm"`, `"select"`, `"multiselect"` (default: text) |
| options      | string[] or object[] | no       | Required when `type` is `select` or `multiselect`. Each item can be a string or `{ "label": string, "description"?: string }` |
| default      | string               | no       | Prefilled value for text input                               |
| timeout      | number               | no       | Auto-cancel after N milliseconds                             |
| allow_custom | boolean              | no       | For `confirm`: also offer "Other (custom)"                   |

## Herdr integration

The extension detects Herdr via the environment variables that Herdr injects
into its panes:

- `HERDR_ENV=1`
- `HERDR_SOCKET_PATH`
- `HERDR_PANE_ID`

If these are present, the extension:

- emits `herdr:blocked` with `active: true` before prompting (the official
  Herdr Pi integration turns this into a `blocked` pane state)
- calls `notification.show` with the question as the body
- emits `herdr:blocked` with `active: false` after the user answers

No extra configuration is required.

## License

MIT
