# Agent guide — HEXART.PL/AfterALL

Notes for **any future AI session** (Claude Code, etc.) working in this
repository. Read this **before** making changes.

## Repository layout

```
aisistAE/
├── CSXS/manifest.xml          # CEP extension manifest — version source of truth
├── index.html                 # Plugin entry (CEP panel root)
├── js/
│   ├── agent.js               # Main agent class — providers, history, prompts
│   ├── providers.js           # Multi-provider abstraction (Gemini/OpenAI/OpenRouter/LMStudio/ComfyUI)
│   ├── elevenlabs.js          # ElevenLabs TTS / STT / SFX / Music
│   ├── orchestration.js       # AssetTracker, PermissionManager, Pipeline
│   ├── mcp-bridge.js          # In-plugin HTTP server (localhost, Bearer auth)
│   ├── main.js                # All UI wiring + i18n dictionary (PL/EN/DE/ES/FR/JA)
│   └── CSInterface.js         # Adobe-provided CEP bridge — DO NOT EDIT
├── jsx/hostscript.jsx         # ExtendScript — UTF-8 BOM + ASCII content only
├── css/style.css              # All styles
├── mcp-server/                # Standalone MCP server (Node, separate npm package)
├── install.bat / uninstall.bat  # Interactive Windows installer (ASCII + CRLF!)
├── CHANGELOG.md               # Keep-a-changelog format
├── VERSIONING.md              # SemVer policy (read this!)
└── AGENTS.md                  # This file
```

## Versioning — read VERSIONING.md and follow it

**Do not edit `CSXS/manifest.xml` without updating CHANGELOG.md and creating
a git tag in the same session.** A version bump that doesn't reach the user
as a GitHub release will permanently break the in-plugin update check.

The release flow is documented in [VERSIONING.md](./VERSIONING.md). Stick to it.

Quick rule of thumb:

| Change                                       | Bump  |
|----------------------------------------------|-------|
| Bugfix, translation, polish, perf            | PATCH |
| New provider, new tool, new tab, new feature | MINOR |
| Breaking change to stored config / MCP API   | MAJOR |

## i18n discipline

- Every user-visible string MUST have a `data-i18n` (or `data-i18n-ph` /
  `data-i18n-html` / `data-i18n-title` / `data-i18n-aria`) attribute.
- Every key MUST exist in **all six** language dictionaries in `main.js`:
  `pl`, `en`, `de`, `es`, `fr`, `ja`.
- For JS-emitted strings use `tr('key')` — **never** branch on
  `_activeLang === 'pl' ? ... : ...`. That pattern leaves DE/ES/FR/JA
  on Polish text and is the #1 source of "mishmash" UI bugs.
- Inline HTML inside translated strings? Use `data-i18n-html`, not
  `data-i18n` (the latter writes via `textContent` and would show
  `<code>` tags as literals).

## ASCII + CRLF for `.bat` files

`cmd.exe` on Polish Windows misparses UTF-8 / LF-encoded batch files
line-by-line (every echo argument turns into a "command not recognized"
error). Always write `.bat` files as **ASCII + CRLF**. After editing,
normalize via:

```powershell
$path = "D:\code\aisistAE\install.bat"
$c = [System.IO.File]::ReadAllText($path)
$c = $c -replace "`r`n", "`n" -replace "`n", "`r`n"
[System.IO.File]::WriteAllText($path, $c, [System.Text.Encoding]::ASCII)
```

Verify first bytes are `40 65 63 68 6F 20 6F 66 66 0D 0A` = `@echo off\r\n`.

## ExtendScript discipline (jsx/hostscript.jsx)

- ES3 only — no `let`, `const`, arrow functions, template literals,
  default parameters, or `=>`. Use `var`, `function`, `+` concat.
- ASCII content only (no em-dash, no Polish characters, no smart quotes)
  — they crash AE's ES3 parser. File starts with a UTF-8 BOM that the
  bridge tolerates, but the bytes after the BOM must be ASCII.
- Every `app.beginUndoGroup(...)` must have a matching
  `app.endUndoGroup()` — wrap in try/finally.

## CEP quirks worth remembering

- `__dirname` for `<script src>`-loaded JS resolves to the **HTML
  directory** (the plugin root). Do NOT do `path.resolve(__dirname, '..')`
  — that overshoots. Use `CSInterface.getSystemPath('extension')`
  as the canonical source.
- `csi.openURLInDefaultBrowser(url)` is how you open external links —
  `window.open` works in some CEP versions but isn't reliable.
- The MCP bridge HTTP server runs inside CEP's Node context. It MUST
  bind `127.0.0.1`, never `0.0.0.0`. Bearer-token authenticate every
  request.

## API key handling — no leaks

We've passed a security audit. Keep it that way:

- Never `addLog(...key...)`, `console.log(...key...)`, or
  `appendMessage(..., key, ...)`. Keys are display-masked via
  `<input type="password">` and stored plaintext in
  `~/.hexart_afterall_data.json` (CEP limitation — no keychain access).
- The system prompt lists Custom Secrets by **name only**. Never by value.
- MCP bridge `/status` returns provider + model name. Never the key.

## Streaming + JSON mode incompatibility

LLM providers buffer the entire response server-side when JSON mode is
on (because partial JSON isn't valid). Every provider's `_buildPayload`
in `providers.js` has a `if (!stream)` guard around the JSON-mode hint.
Don't re-enable JSON mode on streaming calls — you'll silently revert
to non-streaming and the live thinking block will look stuck.

The system prompt already instructs models to emit pure JSON and the
self-repair retry handles the rare preamble/fences case.

## Commit etiquette

- **Conventional-ish** commit titles. First line ≤ 72 chars, imperative
  mood, no period. Body lines wrapped at 72.
- Include the trailer:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- Don't amend existing commits unless explicitly asked.
- One logical change per commit.

## Don't delete user work

Hard-coded rule for the agent runtime, mirror it in your own actions:
**never delete project files / layers / comps that existed before the
task started without explicit user permission.** The `PermissionManager`
in `js/orchestration.js` enforces this at runtime; respect the same
spirit in tooling changes (installers, scripts) — never `rm -rf` the
user's source folder.
