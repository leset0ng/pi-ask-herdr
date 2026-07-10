# askuser-herdr

A Pi extension that adds an `askuser` tool, with optional integration with
[Herdr](https://herdr.dev) notifications and agent state.

## What it does

- Registers an `askuser` tool that can ask the user for:
  - free-form text (`type: "text"`)
  - yes/no confirmation (`type: "confirm"`)
  - single choice from a list (`type: "select"`)
- Waits for the answer and returns it to the agent.
- When Pi runs inside a Herdr pane, it:
  - reports the pane state as `blocked` while waiting
  - sends a Herdr toast notification so the user knows input is needed
  - restores the pane state after the user answers

## Install

Copy or clone this directory into Pi's extensions folder:

```bash
# Global
cp -R askuser-herdr ~/.pi/agent/extensions/

# Or project-local
cp -R askuser-herdr .pi/extensions/
```

Then reload Pi with `/reload`, or test it directly with:

```bash
pi -e ~/.pi/agent/extensions/askuser-herdr/index.ts
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
| type      | string   | no       | `"text"`, `"confirm"`, or `"select"` (default: text) |
| options   | string[] | no       | Required when `type` is `select`                 |
| default   | string   | no       | Prefilled value for text input                   |
| timeout   | number   | no       | Auto-cancel after N milliseconds                 |

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
