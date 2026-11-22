# Dotcom-Tools MCP server

Run website and network tests from locations around the world, straight from Claude, Cursor, VS Code and other AI
assistants that support the [Model Context Protocol](https://modelcontextprotocol.io).

Ask things like:

- "Is example.com slow in Europe and Asia? Check Core Web Vitals."
- "Ping 1.1.1.1 from three continents."
- "Trace the route to api.example.com from Tokyo and tell me where the latency jumps."
- "Is mail.example.com's SMTP server answering on 587 with STARTTLS?"
- "Is 203.0.113.10 on any email blacklist?"

The assistant runs the test on [Dotcom-Tools](https://www.dotcom-tools.com) and gets a short summary per location, plus a
link to the full result page (waterfall, video, Lighthouse report, maps).

## Tools

| Tool | What it does |
|---|---|
| `run_test` | Runs a test from one or more locations (by name, such as "London", or picked automatically across regions). Waits up to 60 s and returns a summary per location. |
| `get_test_result` | A test's summary, or every field for one location (`detail: "full"`). |
| `list_tests` | Your recent tests. |
| `list_test_types` | Every test type with its settings, cost and time limit. |
| `list_locations` | The locations available now. |
| `get_credits` | Your plan and the credits you can spend. |

Test types: website speed (Chrome page load with Core Web Vitals and Lighthouse; desktop or mobile), ping, traceroute,
DNS trace, web server (HTTP timings), email server (SMTP/POP3/IMAP), email blacklist, FTP and streaming media
(HLS/DASH).

## Get an API key

API keys are free. [Create an account](https://www.dotcom-tools.com/register), then create a key on your
[account page](https://www.dotcom-tools.com/account#api). Tests spend the same credits as tests on the website: a free
account gets a daily allowance and up to 5 locations per test; [paid plans](https://www.dotcom-tools.com/pricing) add
credits and every location.

## Setup

Dotcom-Tools hosts the MCP server at `https://www.dotcom-tools.com/mcp`. Clients that support remote (HTTP) servers
can connect to it directly; this package is for clients that run local (stdio) servers. Both give you the same tools.

### Claude Code

```sh
claude mcp add --transport http dotcom-tools https://www.dotcom-tools.com/mcp --header "X-Api-Key: YOUR_KEY"
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dotcom-tools": {
      "command": "npx",
      "args": ["-y", "@dotcom-tools/mcp"],
      "env": { "DOTCOM_TOOLS_API_KEY": "YOUR_KEY" }
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "dotcom-tools": {
      "url": "https://www.dotcom-tools.com/mcp",
      "headers": { "X-Api-Key": "YOUR_KEY" }
    }
  }
}
```

### VS Code

In `.vscode/mcp.json`; VS Code asks for the key once and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "dotcom-tools-key", "description": "Dotcom-Tools API key", "password": true }
  ],
  "servers": {
    "dotcom-tools": {
      "type": "http",
      "url": "https://www.dotcom-tools.com/mcp",
      "headers": { "X-Api-Key": "${input:dotcom-tools-key}" }
    }
  }
}
```

### Any other client

Remote: `https://www.dotcom-tools.com/mcp` (Streamable HTTP) with the header `X-Api-Key: YOUR_KEY`.
Local: run `npx -y @dotcom-tools/mcp` with the environment variable `DOTCOM_TOOLS_API_KEY`.

| Environment variable | |
|---|---|
| `DOTCOM_TOOLS_API_KEY` | Required. Your API key. |
| `DOTCOM_TOOLS_URL` | Optional. The server address, default `https://www.dotcom-tools.com/mcp`. |

## Limits and privacy

- Each key can make 120 requests and start 10 tests a minute.
- Only public addresses can be tested.
- Test settings you pass (such as a login for an email server) are encrypted at rest and masked in results. The server
  doesn't log tool arguments.
- This package only relays messages between your client and the Dotcom-Tools server. It logs nothing but connection
  errors, to stderr.

See the [MCP documentation](https://www.dotcom-tools.com/docs/mcp) and the [REST API](https://www.dotcom-tools.com/docs/api),
which the same key works with.

## Development

```sh
npm install
npm test        # builds, then runs the bridge against a mock server
```

## License

MIT
