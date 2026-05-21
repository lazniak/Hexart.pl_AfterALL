# Changelog

All notable changes to **HEXART.PL/AfterALL** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
as described in [VERSIONING.md](./VERSIONING.md).

## [Unreleased]

(none yet — open work goes here before the next release)

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

[Unreleased]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/lazniak/Hexart.pl_AfterALL/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/lazniak/Hexart.pl_AfterALL/releases/tag/v2.0.0
