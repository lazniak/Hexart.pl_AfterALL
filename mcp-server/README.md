# @hexart/afterall-mcp

**Model Context Protocol server for [HEXART.PL/AfterALL](https://github.com/lazniak/Hexart.pl_AfterALL)** — drive the After Effects AI agent from Claude Desktop, Claude Code, Antigravity, Cursor, or any MCP-compatible client.

## What is this?

This is a thin MCP shim that forwards tool calls over HTTP to the **HEXART.PL/AfterALL** plugin running inside Adobe After Effects. The plugin opens a localhost-only HTTP bridge; this MCP server exposes that bridge as MCP tools.

```
Claude / Antigravity  ←(stdio, MCP)→  afterall-mcp  ←(HTTP localhost)→  AfterALL plugin in AE
```

## Requirements

- Node.js 18+
- [HEXART.PL/AfterALL plugin](https://github.com/lazniak/Hexart.pl_AfterALL) installed in After Effects
- After Effects open, panel visible (Window → Extensions → HEXART.PL/AfterALL), bridge enabled in plugin Settings → MCP Bridge

## Install

```bash
npm install -g @hexart/afterall-mcp
```

Or run directly via `npx`:

```bash
npx @hexart/afterall-mcp
```

## Configure your MCP client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "afterall": {
      "command": "npx",
      "args": ["-y", "@hexart/afterall-mcp"],
      "env": {
        "AFTERALL_PORT": "7890",
        "AFTERALL_TOKEN": "paste-token-from-plugin-settings"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add afterall -- npx -y @hexart/afterall-mcp
```

Set the token via env var:

```bash
export AFTERALL_TOKEN="paste-token-from-plugin-settings"
```

### Antigravity / Cursor / generic MCP

Use the stdio transport with the command `npx -y @hexart/afterall-mcp` and provide `AFTERALL_TOKEN` in the env block.

## Available tools

| Tool | What it does |
|---|---|
| `afterall_status` | Connectivity check + project info |
| `afterall_get_project_context` | Deep scan of AE project |
| `afterall_send_prompt` | Drive the full agent loop with a natural-language prompt |
| `afterall_execute_extendscript` | Run raw ExtendScript directly |
| `afterall_generate_image` | Text-to-image + import to comp |
| `afterall_generate_tts` | Voice synthesis + import |
| `afterall_generate_music` | Music composition (Lyria / Eleven Music) |
| `afterall_generate_sfx` | Sound effects (0.5-22s) |
| `afterall_generate_video` | Image-to-video via Grok |
| `afterall_transcribe_audio` | Word-level transcription |
| `afterall_run_python_task` | Python venv + script execution |
| `afterall_get_screenshot` | Active comp PNG |
| `afterall_render_preview` | Multi-frame timeline PNG grid |
| `afterall_list_voices` | ElevenLabs voice library |
| `afterall_list_skills` | Saved Python + Markdown skills |
| `afterall_list_tools_state` | Plugin tools state |
| `afterall_set_feature_flag` | Toggle a plugin feature |
| `afterall_get_logs` | Tail plugin log buffer |

## Testing

```bash
node src/test-bridge.js --port=7890 --token=YOUR_TOKEN
```

## License

MIT — see [LICENSE](../LICENSE).

---

Made by [Paul Lazniak](https://www.youtube.com/@Lazniak) · [hexart.pl](https://hexart.pl) · Support: [Buy Me a Coffee ☕](https://buymeacoffee.com/eyb8tkx3to)
