# Versioning policy

HEXART.PL/AfterALL uses a **4-segment** version on top of Semantic
Versioning 2.0.0 — `MAJOR.MINOR.PATCH.ITERATION`. The first three
segments follow strict SemVer; the fourth lets us ship many tiny fixes
between proper patch releases without skipping ahead in the SemVer
landscape.

## The four numbers

| Component     | Bump when…                                                                                                  | Example                              |
|---------------|-------------------------------------------------------------------------------------------------------------|--------------------------------------|
| **MAJOR**     | We make a change that **breaks** any of: stored config schema, MCP HTTP bridge contract, public agent API.  | `2.x.x.x` → `3.0.0`                  |
| **MINOR**     | We add **new features** that are backwards-compatible. New provider, new tool, new generator, new tab.      | `2.0.x.x` → `2.1.0`                  |
| **PATCH**     | We ship **a batch of bugfixes / perf tweaks** as a published release. No new features. No schema changes.   | `2.1.0` → `2.1.1`                    |
| **ITERATION** | A single bugfix / polish / tweak pushed live between releases. **Always bump on every commit-able change**. | `2.2.0` → `2.2.0.1` → `2.2.0.2` → …  |

The ITERATION counter resets to omitted (no fourth segment) on every
PATCH / MINOR / MAJOR bump. Practically: any time you change anything
under `js/` `css/` `jsx/` `index.html` `CSXS/` `mcp-server/`, bump the
4th digit. When you accumulate enough iterations to call it a "patch
release", roll them up into a `2.2.1` and reset the iteration counter.

Pre-release tags (used for testing risky changes before stable):

- `2.2.0-beta.1` — first beta of an upcoming minor
- `2.2.0-rc.1`  — release candidate, no new code expected before stable

## Single source of truth

The canonical version lives in **`CSXS/manifest.xml`** in two places that **must always match**:

```xml
<ExtensionManifest ... ExtensionBundleVersion="X.Y.Z.I" ...>
  <ExtensionList>
    <Extension Id="pl.hexart.afterall.panel" Version="X.Y.Z.I" />
```

Adobe's CEP manifest accepts a 1-to-4-component version (`X[.Y[.Z[.I]]]`)
so the 4-segment form passes validation natively.

Everything else derives from there:

- The in-plugin Update card reads `ExtensionBundleVersion` via `agent.getCurrentVersion()`
- The GitHub release / iteration tag is `vX.Y.Z.I` (lowercase `v`)
- The CHANGELOG entry is keyed on `[X.Y.Z.I]` with the release date in ISO format
- `js/main.js` MCP-handshake `version` string mirrors the 4-segment form
- `mcp-server/src/index.js` `PKG_VERSION` mirrors the 4-segment form
- **`mcp-server/package.json`** stays on the 3-segment SemVer (npm rejects
  4 segments). It tracks the most recent PATCH-or-larger release — the
  iteration counter is only visible at the plugin surface.

## Release flow (every time)

**Iteration push** (single fix, 4th segment bumps):

1. **Edit `CSXS/manifest.xml`** — bump both `ExtensionBundleVersion` and `<Extension Version="...">` to `X.Y.Z.I+1`.
2. **Mirror the 4-segment string** in `js/main.js` (MCP handshake `version: '…'`) and `mcp-server/src/index.js` (`PKG_VERSION`).
3. **Update `CHANGELOG.md`** — add a `## [X.Y.Z.I+1] — YYYY-MM-DD` block at the top with the change list.
4. **Commit** with `v2.2.0.1 — <one-line summary>`.
5. **Tag annotated**: `git tag -a v2.2.0.1 -m "v2.2.0.1 — <summary>"`
6. **Push**: `git push origin main && git push origin v2.2.0.1`

**Patch / minor / major release** (rolls up iterations):

1. **Decide the bump** (MAJOR / MINOR / PATCH) based on the table above.
2. **Edit `CSXS/manifest.xml`** — update **both** `ExtensionBundleVersion` and the `<Extension Version="...">`. The 4th segment is omitted (or `.0`).
3. **Update `mcp-server/package.json`** to match the new 3-segment release.
4. **Update `CHANGELOG.md`** — collapse the iteration entries under the new release heading.
5. **Commit** with `Release v2.2.1 — short summary`.
6. **Tag annotated**: `git tag -a v2.2.1 -m "v2.2.1 — short summary"`
7. **Push**: `git push origin main && git push origin v2.2.1`
8. **GitHub release**: `gh release create v2.2.1 --title "v2.2.1 — short summary" --notes-file <(awk '/## \[2\.2\.1\]/,/## \[/' CHANGELOG.md | head -n -1)`
9. **Verify** the in-plugin Update card shows the new version after a CEP cache clear.

## What `git tag -a` gives us

- An **annotated tag** stores the tagger identity, date, and message — it shows up as a real object in `git show`, not just a pointer.
- The Update card detects releases via `GET /repos/:owner/:repo/releases/latest`, then falls back to `GET /repos/:owner/:repo/tags` if no formal release exists. **Annotated tags work for the fallback path**, but a real release is preferred (it has notes + downloadable assets).

## Never do this

- ❌ Edit `CSXS/manifest.xml` without bumping CHANGELOG and tagging — leaves users unable to detect updates.
- ❌ Push a tag whose version doesn't match `manifest.xml` — the Update card will report a permanent "newer version available".
- ❌ Re-use a tag name. Once `v2.1.0` is published, the next change is `v2.1.1` (patch) or `v2.2.0` (minor) — never overwrite history.
- ❌ Skip versions to "look more mature" — semver derives from real changes, not vibes.

## Reference

- Spec: <https://semver.org/spec/v2.0.0.html>
- Keep-a-changelog format: <https://keepachangelog.com/en/1.1.0/>
