# Versioning policy

HEXART.PL/AfterALL follows **Semantic Versioning 2.0.0** — `MAJOR.MINOR.PATCH`.

## The three numbers

| Component | Bump when…                                                                                                  | Example                              |
|-----------|-------------------------------------------------------------------------------------------------------------|--------------------------------------|
| **MAJOR** | We make a change that **breaks** any of: stored config schema, MCP HTTP bridge contract, public agent API.  | `2.x.x` → `3.0.0`                    |
| **MINOR** | We add **new features** that are backwards-compatible. New provider, new tool, new generator, new tab.      | `2.0.0` → `2.1.0`                    |
| **PATCH** | We ship **bugfixes, perf tweaks, UI polish, translations**. No new features. No schema changes.             | `2.1.0` → `2.1.1`                    |

Pre-release tags (used for testing risky changes before stable):

- `2.2.0-beta.1` — first beta of an upcoming minor
- `2.2.0-rc.1`  — release candidate, no new code expected before stable

## Single source of truth

The canonical version lives in **`CSXS/manifest.xml`** in two places that **must always match**:

```xml
<ExtensionManifest ... ExtensionBundleVersion="X.Y.Z" ...>
  <ExtensionList>
    <Extension Id="pl.hexart.afterall.panel" Version="X.Y.Z" />
```

Everything else derives from there:

- The in-plugin Update card reads `ExtensionBundleVersion` via `agent.getCurrentVersion()`
- The GitHub release tag is `vX.Y.Z` (lowercase `v`)
- The CHANGELOG entry is keyed on `[X.Y.Z]` with the release date in ISO format

## Release flow (every time)

1. **Decide the bump** (MAJOR / MINOR / PATCH) based on the table above.
2. **Edit `CSXS/manifest.xml`** — update **both** `ExtensionBundleVersion` and the `<Extension Version="...">`.
3. **Update `CHANGELOG.md`** — move the `Unreleased` block into a new dated heading. Group entries under `Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Performance`.
4. **Commit** with a message like `Release v2.1.0 — short summary`.
5. **Tag annotated**: `git tag -a v2.1.0 -m "v2.1.0 — short summary"`
6. **Push**: `git push origin main && git push origin v2.1.0`
7. **GitHub release**: `gh release create v2.1.0 --title "v2.1.0 — short summary" --notes-file <(awk '/## \[2\.1\.0\]/,/## \[/' CHANGELOG.md | head -n -1)`
8. **Verify** the in-plugin Update card shows the new version after a CEP cache clear.

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
