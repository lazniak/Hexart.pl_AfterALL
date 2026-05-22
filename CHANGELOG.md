# Changelog

All notable changes to **HEXART.PL/AfterALL** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
as described in [VERSIONING.md](./VERSIONING.md).

## [Unreleased]

(none yet — open work goes here before the next release)

## [2.2.0.8] — 2026-05-22

### Fixed
- **External links STILL not opening** in the system default browser
  after v2.2.0.6. Root cause this time: the `cmd /c start "" "url"`
  invocation went through Node's `exec`, which itself wraps the
  command in another `cmd.exe /d /s /c "…"`. The nested-cmd quote
  parsing eats the inner empty `""` placeholder in some Windows
  builds, so `start` interprets the URL as the window title and
  never opens it.

  Rewritten `openExternalUrl` again — 5 strategies in order, each
  logged to the Logs Console with a checkmark / cross marker so the
  user can see exactly which one fired:
    1. **spawn explorer.exe URL** (Windows) / `open URL` (macOS) /
       `xdg-open URL` (Linux). spawn with argv array — no shell,
       no quote nesting. `explorer.exe URL` is Microsoft's most
       reliable way to ask Windows "open this URL in the user's
       chosen default browser".
    2. **exec via shell** (`cmd /c start ""`) as a backup.
    3. **`cep.process.createProcess`** (documented CEP API).
    4. **CSInterface.openURLInDefaultBrowser** (known to silently
       no-op on some Adobe versions, so demoted further).
    5. **`window.__adobe_cep__.openURLInDefaultBrowser`** raw bridge.
    6. **`window.open(_, '_blank')`** last resort.

  The Logs Console now prints `openExternalUrl START → URL` followed
  by `✓` for the strategy that succeeded or `✗` for each one that
  failed. If a future silent failure occurs, the log tells you in
  one line which strategy is broken on the user's machine.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [2.2.0.7] — 2026-05-22

### Added
- **Status-coded "Aktualny plan" card.** Each plan step is now
  classified into READY / ACTIVE / PLANNED by keyword sniff (PL + EN +
  DE + ES + FR + JA forms), rendered as a vertical list with:
    - ✅ green strikethrough for done steps,
    - gold spinner + bold text for the active step,
    - greyed-out neutral row for queued / planned steps,
  plus a coloured left border bar that mirrors the step state. A
  glance at the panel now answers "where are we?" without reading
  every line.
- **Native PowerShell shell-drag bridge (Windows).** Chat asset cards
  now spawn a hidden PowerShell host at mousedown that calls
  `System.Windows.Forms.Form.DoDragDrop` with a populated
  `StringCollection` — the SAME `CF_HDROP` drag format Explorer
  produces. AE accepts that exactly like a Finder/Explorer drag, no
  crossed-cursor. macOS still falls through to the multi-MIME
  Chromium drag (Cocoa's NSFilenamesPboardType handles it natively).
- **Multi-MIME dataTransfer fallback** for the cases where the
  PowerShell bridge can't spawn (corp PS lockdown etc): now writes
  `text/uri-list`, `text/plain`, `DownloadURL`,
  `application/cep-file-uri`, `com.adobe.cep.draggedFile`,
  `application/x-moz-file`, `text/x-moz-url` — whichever one AE's
  drop handler reaches for, it'll find a valid payload.

### Changed
- `CSXS/manifest.xml` CEFCommandLine extended with
  `--disable-features=BrowserDragFix` and
  `--enable-blink-features=DocumentDOM`. Chromium's modern
  "BrowserDragFix" feature gimps HTML5 drag for embedded contexts;
  disabling it restores the older / saner drag behaviour. The
  PowerShell native bridge is the primary path regardless.
- `effectAllowed` on chat asset drags switched from `'copyMove'` to
  `'all'` so every drop handler in AE accepts the cursor variant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [2.2.0.6] — 2026-05-22

### Fixed
- **External links still opening in-panel** for some users despite the
  v2.2.0.1 helper. Root cause: `CSInterface.openURLInDefaultBrowser()`
  silently no-ops on several Adobe CEP versions — the call appears to
  succeed but nothing actually opens. The helper put CSInterface first
  in its fallback ladder, so the silent failure won the race against
  the Node fallback.

  Rewritten `openExternalUrl()` with a new strategy order:
  1. **Node child_process exec** (`cmd /c start "" "url"` on Win,
     `open` on macOS, `xdg-open` on Linux) — most reliable across
     every CEP version, properly shell-quoted so URLs with `&` in
     query strings don't get truncated.
  2. CSInterface.openURLInDefaultBrowser (now demoted to backup).
  3. Raw `window.__adobe_cep__.openURLInDefaultBrowser` (in case the
     CSInterface wrapper itself is broken).
  4. `window.open(_, '_blank')` (last resort).

  Each strategy logs to the Logs Console which one fired, so a future
  silent failure is diagnosable in 10 seconds (`Logs Console →
  openExternalUrl: opened via …`).

  Also added an `auxclick` (middle-click) handler so clicks via
  scroll-wheel buttons follow the same path, and a defensive
  `beforeunload` interceptor that catches any rogue `location.assign`
  call attempting to navigate the panel itself away from `file://`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [2.2.0.5] — 2026-05-22

The "built-in offline LLM" release. Adds Ollama as a first-class
provider so users can run the agent end-to-end on their own machine
without ever entering an API key, and ships a macOS installer that
sets up every prerequisite automatically.

### Added
- **OllamaProvider** (`js/providers.js`) — full OAI-compatible chat +
  Ollama-native `/api/tags` (list installed models), `/api/pull`
  (streaming download with progress events), `/api/delete`,
  `/api/version` (daemon health probe). Curated Gemma 3 / Gemma 2
  catalog (1B / 2B / 4B / 9B / 12B / 27B) surfaced in the picker
  with size, family, and recommendation badge.
- **Built-in Local (Gemma 3 · Ollama)** as the first option in the
  LLM provider dropdown. `hasAnyConfiguredLLM()` and the auto-disable
  gate both treat Ollama as a satisfied LLM credential (it's local,
  no key needed) — exactly like LM Studio.
- **Provider config card** in Settings → LLM Providers with:
    - Live status banner (running / not detected / install link)
    - GPU detection badge (NVIDIA CUDA / Apple Metal / AMD / Intel /
      CPU-only), reading `nvidia-smi`, `sysctl machdep.cpu`,
      `system_profiler SPDisplaysDataType`, and WMIC respectively.
    - Model picker that lists installed + curated-not-yet-pulled.
    - **⬇ Pull button** with live progress bar (status text +
      percent) streamed from `/api/pull`.
    - Configurable Ollama base URL.
- **`install-macos.command`** — double-click installer for macOS:
  detects Xcode CLT, installs Homebrew (with consent), installs
  git + Python 3.11 + Ollama via brew, pulls `gemma3:4b` (~2.6 GB)
  on first run, copies the plugin into
  `~/Library/Application Support/Adobe/CEP/extensions/`,
  enables PlayerDebugMode for CEP versions 9–18. Idempotent — safe
  to rerun.
- **i18n keys** for the new card (PL + EN): `provider-ollama`,
  `ollama-model-label`, `ollama-url-label`, `ollama-status-*`,
  `ollama-install-link`, `ollama-gpu-label`, `ollama-hint`,
  `ollama-pull-done`, `mp-title-ollama-llm`. DE/ES/FR/JA fall back
  to EN via the `t()` helper.

### Changed
- LLM provider dropdown now defaults to the Built-in Local option,
  reflecting the new no-config-needed onboarding path.
- `STORAGE_KEYS` extended with `ollamaBaseUrl` /
  `ollamaLLMModel` so the new fields persist alongside every other
  provider's state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [2.2.0.4] — 2026-05-22

The "stop wasting 7 turns on the same broken Python env" release.

Triggered by a user report: an AI-3D-generation task spun for ~10 min
across 7 LLM round-trips. The orchestrator kept reinstalling the same
packages (`trimesh, numpy, scipy, gradio_client`) every turn, the
Python output was truncated at "Requirement already satisfied: n" so
the orchestrator never saw the actual script error, and the JSON
parser hit format-error → self-repair → format-error again until the
user killed the task. Six independent failures stacked. Fixed:

### Added
- **Pre-flight import check before `pip install`.** Before kicking
  off a full pip run, the runner asks Python to `import` every
  requested package via `python -c "import a; import b; …"`. If that
  succeeds we skip `pip install` entirely with a `pip_skip` result
  step. Common pip→import name mismatches (Pillow→PIL, opencv-python
  →cv2, beautifulsoup4→bs4, scikit-learn→sklearn, …) are mapped
  through `_pipToImportName()` so the check actually works for the
  packages users install in practice. **Saves 5–15 s per turn** on
  repeat tasks.
- **Smart head+tail truncation (`_smartTruncate`)** replaces the
  old `substring(0, 500)` / `substring(0, 8000)` slices. The new
  helper preserves the FIRST `N/2` chars + the LAST `N/2` chars
  with an `…[K chars elided — full log on disk]…` marker in
  between. The orchestrator now always sees the FINAL exception line
  (the only line that matters for planning a fix), not just the boring
  pip-install preamble.
- **Full per-run log on disk** at `<envDir>/.runs/run_<ts>.log` —
  unabridged stdout + stderr + return code + duration + task summary.
  Path bubbled back to the agent as `full_log_path` so it can
  `attach_files` for deeper inspection when the truncated copy isn't
  enough. Capped at the most recent 20 logs per env (older ones GC'd).
- **Python error classification (`_classifyPythonError`)** parses
  stderr and returns a structured `{ cls, hint, missingModule? }`:
    - `missing_module` — extracts the module name from
      `ModuleNotFoundError: No module named 'X'`.
    - `import_error` / `file_not_found` / `permission_denied` /
      `out_of_memory` / `network` / `auth_error` /
      `hf_space_error` / `python_exception` / `unknown`.
  Each comes with a one-line `hint` the orchestrator can act on.
- **Auto-repair: missing module → pip install → retry script ONCE.**
  When the script's stderr contains `ModuleNotFoundError: 'X'` we
  immediately run `pip install X` and re-run the script. Bounded to
  a single auto-repair per turn so we never chain repairs into a
  loop. The result step exposes `auto_repair: { installed, retry_success }`
  so the orchestrator knows what happened.
- **Loop detection.** A stable hash of the Python task definition
  (env + packages + script + command) is recorded for the last six
  invocations. When the same hash appears 3+ times in a row we add a
  `loop_detected` result step warning the agent to STOP, change
  approach, or call questions_for_user. The audit log surfaces this
  earlier than the user would notice.
- **Stale temp-script GC.** `script_<ts>.py` files older than an
  hour (left behind by crashed / aborted runs) are unlinked at the
  start of every Python step so env folders don't accumulate junk
  over long sessions.
- **Script file kept on failure** for post-mortem inspection (and
  surfaced as `script_path_on_failure` in the result). On success
  the temp script is cleaned up as before.

### Changed
- `run_script` and `run_command` result entries now include
  `return_code`, `duration_ms`, `error_class`, `error_hint`, and
  `full_log_path` alongside the (now smart-truncated) stdout/stderr.
  Total payload per step roughly doubles, but eliminates 6+ wasted
  turns trying to figure out what went wrong.
- `pip_install` and `pip_error` step outputs widened from 500 chars
  to 1 500–2 000 chars (still smart-truncated). The pip preamble
  ("Requirement already satisfied") no longer eats the budget — the
  important install errors land in the tail half.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [2.2.0.3] — 2026-05-22

### Added
- **Tool palette gate at top of system prompt.** New
  `getToolPaletteSummary()` produces a structured block listing every
  parallel_tasks-eligible tool (imageGen, imageEdit, videoGen, ttsGen,
  sttGen, musicGen, sfxGen, svgGen, grounding, renderPreview, pythonTools)
  with a per-row ✅ ON / ⛔ OFF marker, the corresponding
  `parallel_tasks.<key>` reference, the credential it depends on, and a
  one-line reason if disabled (`auto-OFF: required API key missing` vs
  `manually disabled in Settings → Funkcje`). Custom Python skills the
  user saved are appended at the end so the orchestrator can reference
  them by name. Injected immediately after the ★ LANGUAGE DIRECTIVE so
  it sits in the LLM's most-attended region.
- **PALETTE-FIRST hard gate** prepended to "Rules and Warnings:" — a
  short paragraph that forces the model to verify every intended tool
  against the palette BEFORE composing current_plan / parallel_tasks /
  ExtendScript. Spells out the two acceptable responses to a ⛔ tool:
  substitute an enabled alternative, or defer + ask the user to add
  the missing key. NEVER write a parallel_tasks entry for a disabled
  tool — the runtime rejects it.

### Changed
- The legacy "⚠ DISABLED FEATURES" line is preserved as a terse
  reminder next to the provider stack but now points back to the
  palette block for the full reasoning ("see palette above for reasons").

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [2.2.0.2] — 2026-05-21

### Fixed
- **LM Studio chat pre-flight blocked all chat without Gemini key.**
  `handleSend()` checked `if (!agent.apiKey)` (Gemini-only) before
  letting any prompt through. LM Studio is local and its API key is
  optional, so users who selected LM Studio as their LLM provider and
  hadn't entered a Gemini key were getting "⚠ No API key entered.
  Click the gear icon to fix this." in chat with no way to proceed.
  The check now uses `hasAnyConfiguredLLM()` — true when any of Gemini /
  OpenRouter / OpenAI keys are set OR the active provider is LM Studio.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [2.2.0.1] — 2026-05-21

First iteration on top of 2.2.0 (see VERSIONING.md for the 4-segment
scheme). External-link safety + reliable drag-from-chat to AE.

### Added
- **openExternalUrl(url)** — single helper that routes every external
  `<a href>` click through `CSInterface.openURLInDefaultBrowser`, with
  a Node `child_process` shell-out as a fallback. Exposed as
  `window.openExternalUrl` and additionally wired as a capture-phase
  click delegate on `document` so any future link rendered inside chat
  markdown, modals, or dynamically-injected content opens in the
  user's system browser instead of replacing the plugin panel.
  Scheme allow-list: http, https, mailto only — `javascript:` /
  `data:` payloads are blocked at the helper level.
- **Local drag-proxy server** for chat asset → AE drag-and-drop. Tiny
  HTTP server on `127.0.0.1` (random free port) that streams an asset
  file back when given a valid single-use token (30 s TTL). Chromium's
  `DownloadURL` drag pattern only works with http(s); without this,
  AE rejected every drag from the chat panel with the crossed-out
  cursor. The proxy now powers the drag handoff so AE accepts the
  drop the same way it would from a Finder/Explorer drag.
- **Click-to-import "+" button** on every chat asset card — a
  guaranteed-works alternative to the OS drag handoff. The button
  calls `importAndAddToComp(filePath)` via ExtendScript and lands the
  asset in the active composition. Gold-accent circular button next
  to the existing drag hint; works even when the drag proxy can't
  bind a port.

### Changed
- Seven internal call sites that used to instantiate `CSInterface`
  ad-hoc to call `openURLInDefaultBrowser` (hexart logo, BMC button,
  BMC teaser video, three credit links, API-help modal links, two
  GitHub-update links) refactored to use the new
  `openExternalUrl` helper.
- `dataTransfer.effectAllowed` on chat asset drags switched from
  `'copy'` to `'copyMove'` so AE's drop indicator shows the correct
  affordance.
- **Versioning policy** moved to a 4-segment `MAJOR.MINOR.PATCH.ITERATION`
  scheme. The 4th segment ("iteration") bumps on every push between
  proper PATCH releases — so the user always sees the in-plugin
  Update card pick up the latest fix. `VERSIONING.md` rewritten
  with the new flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [2.2.0] — 2026-05-21

The "polish, persistence and parallel proofing" release. New first-run
experience, restart-aware update flow, robust markdown chat rendering,
expandable pipeline rows, plus a 5-sprint codebase audit that cuts
~5 000 LLM tokens per turn, eliminates 250+ lines of duplication, and
fixes two latent crash classes — without breaking a single feature.

### Added
- **First-run welcome card** with embedded YouTube tutorial slot, side-by-side
  provider comparison (OpenRouter / Gemini / OpenAI / LM Studio), and one-click
  CTA into Settings → Secrets. Replaces the bare chat input when no LLM key
  is configured. Full i18n across all six languages.
- **Optional LM Studio API key field** for users behind reverse proxies or
  Bearer-auth gateways. Default flow (no auth) unchanged.
- **Post-update restart-AE prompt**: after a successful in-plugin `git pull`,
  a gold "Restart now" / muted "Later" modal asks the user to relaunch
  After Effects. The detached spawner waits 5 s then re-launches AfterFX.exe
  (Windows) / open -n (macOS) before `app.quit()` for a clean handoff.
  Full i18n in all six languages.
- **Relative timestamps above chat messages** ("3 s temu" / "5 min temu" /
  "2 h ago" / "1 d ago" — auto-rolling to absolute `YYYY-MM-DD HH:MM:SS`
  for entries older than a month). Localized in all six languages.
- **Markdown rendering in chat** with an XSS-safe pipeline: HTML-escape →
  pull fenced code blocks → pull inline code → walk block-level (headers,
  lists, blockquotes, hr) → inline (bold, italic, strike, links). Link
  schemes restricted to http/https/mailto.
- **Expandable pipeline rows** (`<details>` element) with live-log body
  and embedded asset preview when the step finishes. Caches DOM identity
  by signature so concurrent updates don't churn the tree.
- **Stronger pipeline colours** (per-status borders, checkmark stamp on
  completion) and a new `warning` status for partial success.
- **In-plugin update detection** with GitHub poll, version compare,
  release notes preview, and an opt-in `git pull` button.
- **Per-tool settings forms** (now driven from a schema registry) and a
  dynamic Tools modal that surfaces Python skills the agent created.
- **Save-project pre-flight modal** (single-step now — see Changed): if
  the project is unsaved, the agent recommends saving so assets land in
  `<projectFolder>/aisist_assets/` rather than the system temp folder.

### Changed
- **Save-project modal simplified** from two steps to one — only
  "Continue without saving" / "Save project now" buttons. Consequences
  surface inline rather than behind a confirmation dialog.
- **`.hidden` CSS class is now global** (`display: none !important`). All
  the per-element scoped `.hidden` rules that did the same job were
  removed — net 25 fewer CSS lines and any future `classList.add('hidden')`
  call actually hides the element.
- **Decomposed colour CSS variables** — `--accent-rgb`, `--success-rgb`,
  `--danger-rgb`, `--warning-rgb` (numeric tuples for `rgba(var(...), op)`)
  plus `--accent-dark` for save-button gradients. 156 colour literals
  collapsed into 5 variables.
- **systemInstruction is now cached** on a fingerprint of every runtime
  field that affects it (provider, model, LTM length, snapshot timestamp,
  feature flags, eleven voice config, etc). Previously the 50 000-char
  template rebuilt on every getter access — `_trimHistoryForBudget` alone
  triggered it once per LLM call.
- **Polish copies of system-prompt rules 35–43 removed** — they were
  byte-for-byte duplicates of the English versions and wasted ~5 000
  tokens per LLM call. The unique Polish rule 34 (WHISPERX) was
  translated to English and renumbered to rule 44.
- **Gemini streaming disabled at the dispatch level**. The
  `streamGenerateContent` endpoint has been the source of repeated
  empty bodies / multi-minute hangs / thinkingConfig 400s; the agent
  now routes Gemini straight through `chatCompletion()`. All the
  providers.js streaming code is preserved for future re-enablement.
- **All save-project / no-API-key / task-complete log lines** now route
  through `tr()` — non-PL users no longer see Polish strings in the
  Logs Console.
- **Modal CSS** consolidated: `.settings-footer`, `.or-model-head`,
  `.picker-features label`, `.tool-detail-tabs`, `.ps-step` no longer
  have duplicate declarations.
- **CSInterface lookup**: 18 sites that each did `new CSInterface()`
  now share one cached instance via `this._csi()` lazy accessor.
- **OpenAI-shape SSE extractors** (OpenRouter, OpenAI, LM Studio)
  consolidated into two static helpers on BaseProvider — ~40 lines of
  duplication collapsed.
- **ExtendScript iteration helpers** (`eachItem`, `eachComp`,
  `eachFootage`, `escJSON`, `escJSONmulti`) hoisted to module scope.

### Fixed
- **`r.prompt.substring is not a function` crash** when the agent emitted
  the object form `{prompt, duration_seconds, ...}` for music/SFX entries
  and the orchestrator tried to slice a substring of it for the asset
  card. Added `promptToString()` helper at the dispatcher boundary and
  hardened `promptToSlug` itself against non-string inputs.
- **TTS `prompt.match()` crash** on the same object-form input — TTS
  prompts now coerced to string at the function entry.
- **Gemini model selection not persisting** across restarts (would always
  snap back to `gemini-3.1-pro-preview` or similar). The agent used to
  read the legacy `aisist_base_model` key BEFORE the modern
  `hexart_gemini_model`; the legacy value wins and never got cleared.
  Fix: read modern key first; legacy is now a one-time migration source
  that is unconditionally purged after first read.
- **Gemini streaming-broken cache reset per call**: `getProvider()` builds
  a fresh provider instance every LLM round-trip, so instance-level
  `_streamingBroken` / `_thinkingConfigBroken` caches reset on every
  call and the slow probe repeated 60–180 s every turn. Promoted the
  caches to class-level statics that survive instance churn.
- **Gemini streaming auto-retry without `thinkingConfig`** on empty
  streams for `gemini-3.5-flash` and other 3.x checkpoints, plus a
  permanent skip-streaming cache so subsequent calls go straight to
  non-streaming.
- **Welcome card / no-API-key fallback no longer persists** after a key
  is saved. The `#api-setup-fallback` and `.input-wrapper` elements were
  missing scoped `.hidden` CSS rules — `classList.toggle('hidden', …)`
  silently no-op'd. The new global `.hidden` rule (see Changed) closes
  the bug across the file.
- **Welcome card removed from chat history on first key save** so the
  stale instruction banner doesn't linger.
- **install.bat ANSI garbage**: rewritten without escape sequences for
  universal `cmd.exe` compatibility (older Windows builds rendered the
  raw `^[[96m` sequences as `96m1m` text and the parser choked).
- **JSON-mode dropped for streaming calls** — when `responseMimeType:
  'application/json'` was set on a stream request, Gemini would buffer
  the whole response into one chunk (or return empty). Stream path now
  strips the `responseMimeType` and falls back to non-streaming if the
  upstream still buffers.
- **Grounding model swap killed**: orchestration calls used to swap
  to the configured grounding model mid-task, which broke
  multi-turn JSON contracts. Orchestration now stays on the main LLM.
- **Lyria `promptToSlug` was called with the raw object form** instead
  of the unwrapped `textPrompt` (same crash class as the
  `r.prompt.substring` bug); now uses `textPrompt`.
- **Lyria lyrics LTM push** previously didn't persist (in-memory only,
  vanished on restart) and lacked a `category` (showed up unfiltered
  in groupBy). Now tagged `category: 'lyria_lyrics'` and written via
  `diskStorage.setItem(STORAGE_KEYS.memoryArr, …)`.
- **ExtendScript helpers** (`findCompByName`, `getProjectFolder`,
  `listFootagePaths`) lacked try/catch; a null `app.project` during
  AE startup crashed the bridge. Now safe.
- **Dead `addLog` calls in `getAESnapshot`**: `addLog` was a local
  inside main.js's IIFE and was never visible to agent.js, so the
  snapshot diagnostic logs never fired. Now uses
  `window.afterallAddLog`.
- **Third redundant `settingsBtn` click handler** removed — it just
  called `renderCustomSecrets()`, which is now in the main handler.
- **22 dead i18n keys** pruned (orphaned from previous refactors).

### Security
- Verified API keys never appear in `addLog` / `console.log` /
  `appendMessage` after the orchestrator changes. The URL-with-`?key=`
  pattern in Gemini TTS / Lyria calls is documented for future
  fetch-URL loggers to scrub.
- Source-folder protection preserved across the new restart-AE flow.

### Internal
- 5-sprint codebase audit across `agent.js`, `providers.js`, `main.js`,
  `hostscript.jsx`, `style.css` (commits `e3e275e` → `2a39266`).
- Type guards on `promptToSlug`, `generateSpeechBase64`, and
  `generateSpeechAndImport` so the LLM emitting `{prompt: ...}` instead
  of a string can never crash the dispatcher.
- `STORAGE_KEYS` frozen constant (50 keys) added at the top of
  `agent.js` as documentation for future call sites.
- Named timing constants (`DOM_SETTLE_MS`, `SETTINGS_PERSIST_MS`,
  `POST_UPDATE_MODAL_MS`, `POST_GREETING_MS`, `SILENT_UPDATE_CHECK_MS`,
  `ABORT_SETTLE_MS`) replace the cluster of unexplained `setTimeout`
  durations.
- Three unreachable `else throw new Error("Brak dostępu do Node.js")`
  branches removed; the surrounding `typeof require !== 'undefined'`
  guards are kept defensive.

## [2.1.0] — 2026-05-21

The "audio, agents, and accountability" release. New LLM/Image providers,
a real catalog picker, end-to-end streaming, audit-clean key handling,
and a proper installer + update flow.

### Added
- **OpenAI provider** (LLM + Image): native `/v1/chat/completions` with SSE
  streaming, native `/v1/images/generations` for `gpt-image-1` / DALL·E 3 /
  DALL·E 2, multipart `/v1/images/edits` for inpainting. Reasoning-model
  detection (o1/o-mini/gpt-5*) swaps the `max_tokens` field for
  `max_completion_tokens`. Optional org/project headers + custom base URL.
- **ComfyUI provider** (Image): POST `/prompt`, poll `/history/{id}`, fetch
  output via `/view`. Workflow JSON template with `__POSITIVE_PROMPT__` /
  `__NEGATIVE_PROMPT__` / `__SEED__` / `__WIDTH__` / `__HEIGHT__`
  placeholder substitution. Built-in default SDXL workflow.
- **Generic model picker modal** for Gemini and OpenAI mirroring the
  OpenRouter UX: search, sort (Recommended / Price ↑ / Price ↓ / Name /
  Context ↓ / ID), per-row Vision / Tools / JSON / Reasoning / Preview /
  Legacy badges, context window + output cap, description excerpt.
  Reasoning-only filter for LLM kind.
- **Price column** for OpenAI + Gemini in the picker, sourced from the
  community-maintained LiteLLM JSON (`model_prices_and_context_window.json`).
  Provider-aware lookup with date-suffix and preview-suffix fallbacks.
  Cached 24h; in-flight de-dupe.
- **Grounding model selector** for OpenAI (default `gpt-4o-search-preview`)
  and LMStudio (user-picked from the same list as the main LMStudio model).
  Routed through `agent.getModelForCall(needsGrounding)`.
- **In-plugin update detection** (Settings → General → 🔄 Plugin updates):
  reads local version from `CSXS/manifest.xml`, hits GitHub
  `/releases/latest` (falls back to `/tags`), shows install vs. latest with
  publish date. "⬇ Pull via git" button when the install is a git checkout,
  otherwise "↗ Open release page" + "↗ Open repository".
- **GitHub star CTA** at the bottom of the Update card with live star count
  (formatted 1.2k / 12k / 1.4M, throttled to once per Settings open).
- **Interactive `install.bat`**: ANSI-colored menu with detection of
  current install (junction / file copy / none), legacy install, config
  file. Actions: install (junction), install (copy), reinstall, uninstall,
  factory reset (typed "YES" confirmation), clear cache, diagnose. Source
  folder is never deleted. CRLF + ASCII encoding (Polish Windows safe).
- **`uninstall.bat`** companion with the same link-aware removal.
- **i18n**: provider dropdown labels, Permissions tab (all six languages
  including operation names, request modal, rule list, confirm dialogs).
- **Music + SFX cards** split out of the old combined "SFX & Music" card.
  Each modality has its own explicit provider selector.
- **TTS/STT tab** opens with an "Audio providers — at a glance" overview
  showing the active provider per modality as colored chips.
- **VERSIONING.md** + **AGENTS.md** documenting the release discipline.

### Changed
- **Streaming actually streams now.** Every provider's `_buildPayload`
  used to attach `response_format=json_object` (or Gemini's
  `responseMimeType: 'application/json'`) on streaming calls — which
  makes the server buffer the entire response and emit it as one chunk
  at the end. Now JSON-mode is only sent on non-streaming calls.
  Live thinking block ticks per token across Gemini, OpenAI,
  OpenRouter, LMStudio.
- **First-run defaults** flipped: LLM provider = OpenRouter, model =
  `anthropic/claude-opus-4.7`, grounding model = `perplexity/sonar-pro-search`.
  Existing users keep their stored choices.
- **Voice Library modal**: source dropdown change refetches the right
  endpoint, infinite scroll via `/v1/shared-voices?page=N`, dedup on
  append, full PL + EN strings for status / errors / badges / buttons.
- **Settings footer**: Save button moved to the far right with prominent
  gradient + lift-on-hover; credits block now sits to its left.
  Narrow-panel media query collapses to centered full-width layout.
- **Thinking block** starts collapsed by default; chat container
  auto-scrolls with the live stream while respecting user manual
  scroll-up (paused if > 120px from bottom).
- **Settings-open dropdown refresh**: always re-loads the active
  provider's model list (cache makes it free) so dropdowns can't get
  stuck in stale state.
- **Picker apply** replaces the underlying `<select>` options with the
  full picker cache — no more "imaginary" lone entries left behind by
  earlier picks.

### Fixed
- ElevenLabs `/v1/shared-voices` rejecting `sort=popular/latest/usage` —
  now maps to canonical `cloned_by_count` / `created_date` /
  `usage_character_count_1y` / `trending`.
- `install.bat` was Unix-LF encoded; rewritten as ASCII + CRLF.
- `pluginRoot()` in CEP was overshooting via `path.resolve(__dirname, '..')`
  because `__dirname` already IS the plugin root. Now probes
  `CSInterface.getSystemPath('extension')` first and falls back through
  candidate paths.
- Model picker overlay missing from the universal CSS selector groups
  caused it to render inline (off to the side) instead of as a fixed
  centered overlay, and never honor `.hidden`.

### Security
- Audit completed: no `addLog` / `console.log` / `appendMessage` calls
  embed API key values. MCP bridge `/status` exposes provider + model
  name only — never the key. Bridge is localhost-only with Bearer auth.
- Documented inherent caveats: Gemini API requires the key in the URL
  (no Bearer header support); storage at
  `~/.hexart_afterall_data.json` is plaintext JSON (CEP has no OS
  keychain access).

## [2.0.0] — 2026-05-20

Initial public release.

- Plugin renamed from "Aisist AE Gemini Agent" to **HEXART.PL/AfterALL**.
- Multi-provider abstraction (Gemini, OpenRouter, LMStudio).
- ElevenLabs TTS + STT (Scribe v2) + SFX + Music.
- Tools registry, feature flags, permission manager, asset tracker.
- MCP bridge for Claude Code / Antigravity control.
- Six-language UI (PL, EN, DE, ES, FR, JA).
- LICENSE, .gitignore, README.

[Unreleased]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0.8...HEAD
[2.2.0.8]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0.7...v2.2.0.8
[2.2.0.7]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0.6...v2.2.0.7
[2.2.0.6]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0.5...v2.2.0.6
[2.2.0.5]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0.4...v2.2.0.5
[2.2.0.4]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0.3...v2.2.0.4
[2.2.0.3]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0.2...v2.2.0.3
[2.2.0.2]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0.1...v2.2.0.2
[2.2.0.1]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.2.0...v2.2.0.1
[2.2.0]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/lazniak/Hexart.pl_AfterALL/releases/tag/v2.0.0
