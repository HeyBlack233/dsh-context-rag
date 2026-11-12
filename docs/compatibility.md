# DSH Compatibility

This document records which DeepSeek Harness (DSH) releases the plugin accepts,
how DSH enforces that decision, and how the range is widened or narrowed.

## Supported range

| Declaration | Value | Where |
| --- | --- | --- |
| `engines.dsh` | `^0.2.1-rc.2` | [package.json](../package.json) |
| `peerDependencies["@deepseek-ai/dsh-tools"]` | `^0.2.1-rc.2` (mirror) | [package.json](../package.json) |
| `devDependencies["@deepseek-ai/dsh-tools"]` | `0.2.2-rc.2` (exact, tested) | [package.json](../package.json) |

`^0.2.1-rc.2` expands to `>=0.2.1-rc.2 <0.3.0-0`:

| DSH release | Result |
| --- | --- |
| `0.2.0-rc.2` and older | rejected |
| `0.2.1-alpha.1` .. `0.2.1-rc.1` | rejected |
| `0.2.1-rc.2` .. `0.2.2-rc.2` (current) | accepted |
| future `0.2.x` releases and prereleases | accepted |
| `0.3.0-alpha.1`, `0.3.0-rc.1`, `0.3.0` and later | rejected |

The tested points are the floor `0.2.1-rc.2` (the version the plugin was
developed against) and the head `0.2.2-rc.2` (the current local installation).
Releases between them are accepted on the strength of the API audit described
below. A `0.3.0` line requires an explicit new range after review.

Last verified on 2026-11-13: the matrix is green, and a floor smoke test on
`0.2.1-rc.2` booted the Web UI with the bundle active, answered
`POST /plugins/dsh-context-rag/api {"action":"status"}` with
`200 {"ok":true}`, and shut down without plugin errors.

## How DSH enforces the range

The decision lives in `evaluatePluginCompatibility` in
`@deepseek-ai/dsh-app-boot`, which runs without importing plugin code:

1. If the manifest declares `engines.dsh`, **that range decides alone** and
   `@deepseek-ai/dsh*` peers are ignored. This has been true since
   `0.2.1-alpha.3` (upgrade guide `v0.2.1-alpha.3/plugin-engines-dsh`).
2. Otherwise every `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peer must
   match. Older hosts only implement this peer rule.
3. The version compared against the range is **the running DSH version**, not
   the version of the installed `dsh-tools` package. Declaring a peer on
   `dsh-tools` therefore expresses "which DSH releases provide a compatible
   host", not "which copy of dsh-tools we tested".
4. Ranges are evaluated with `semver.satisfies(..., { includePrerelease: true })`.
   Prereleases participate, so the upper bound must be written as
   `<0.3.0-0`; a plain `<0.3.0` also admits `0.3.0-alpha.1` and `0.3.0-rc.1`.
5. The requirement is checked in three places: bundle installation
   (`plugin_manager`, refusal `incompatible-version`), profile startup (the
   bundle is skipped and reported), and Loader row preflight (the row is
   disabled with a reason). A mismatch disables the plugin; it does not crash
   the Host.

Why both `engines.dsh` and the mirrored peer: hosts at or after
`0.2.1-alpha.3` read only `engines.dsh`, while older hosts read only peers.
Declaring the same range in both keeps one consistent answer everywhere, and
[test/manifest.test.js](../test/manifest.test.js) fails if they drift. The
`devDependency` stays a single exact version so test runs are reproducible.

## Why the floor is `0.2.1-rc.2`

The plugin imports exactly one symbol from `@deepseek-ai/dsh-tools`: the root
export `defineTool`. Comparing the published `0.2.0-rc.2`, `0.2.1-rc.2`, and
`0.2.2-rc.2` packages shows an identical `defineTool` contract
(`parameters`, `output.schema`, `execute`, `timeoutMs`); the `0.2.2` break was
removing the `./types` subpath and adding `./pipeline`, neither of which this
plugin uses. The host surfaces it relies on (`ctx.inject`, `ctx.effect`,
`ctx.on`, `tools.register`, `webServer.register`, `sessionProjections.stateOf`,
the `plugins.bundle.config` slot, `locale.register`) are either feature-detected
or degrade to "feature off" when absent.

The floor is nonetheless `0.2.1-rc.2` rather than `0.2.0-rc.2` because that is
the oldest release this plugin has actually run on; lowering it further
requires a floor smoke test (see below), not just a symbol audit.

## Runtime resolution

A registry-installed bundle resolves `@deepseek-ai/dsh-tools` through the shared
anchor `$DSH_HOME/profiles/node_modules`, which links every host package to the
running installation. A locally linked plugin (this repository during
development) resolves it from its own `node_modules` first, which shadows the
anchor. When testing the floor, reinstall the repository dev dependencies at
that version first, for example:

```bash
npm install --no-save @deepseek-ai/dsh-tools@0.2.1-rc.2
node scripts/compat-matrix.mjs
npm install   # restore the tested 0.2.2-rc.2 copy
```

## Node.js

DSH has required Node.js 24.9 or newer since `0.2.1-rc.2` (upgrade guide
`v0.2.1-rc.2`), so in practice the plugin always runs on Node 24. Its own
`engines.node: ">=22"` only describes what the plugin code needs (`node:sqlite`
works on Node 22.23). The two requirements are independent.

## Verification tiers

1. **Matrix** — `node scripts/compat-matrix.mjs` feeds the manifest to the
   running installation's `evaluatePluginCompatibility` and asserts that every
   supported release is admitted and that `0.3.0-rc.1` is rejected. Run it after
   any range change.
2. **API audit** — before lowering the floor or accepting a new minor, diff the
   candidate release's `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-client-locale`,
   and `@deepseek-ai/dsh-client-ui-plugin-manager`/slots packages against the
   symbols the plugin uses.
3. **Floor smoke** — install the candidate release into a throwaway prefix
   (`npm install --prefix /tmp/dsh-floor @deepseek-ai/dsh@0.2.1-rc.2`), boot
   `dsh web` with a throwaway `DSH_HOME`, install/link this plugin, and check
   that the plugin page renders its panel and that `POST
   /plugins/dsh-context-rag/api {"action":"status"}` answers. Keep the anchor
   version in mind: the plugin's own `node_modules` must hold the same floor
   `dsh-tools`.

The unit suite (`npm test`) covers manifest validity, not host compatibility;
a green `npm test` alone never justifies widening the range.

## Changing the range

- **New `0.2.x` release**: read the matching `docs/upgrade-guide` sections for
  the surfaces listed above, run the matrix and the audit, bump the
  `devDependencies` version to the newest tested release, and leave the range
  alone unless an audit fails.
- **Audit failure inside the range**: either add feature detection/code that
  tolerates the change, or raise the floor past the breaking release and update
  this document.
- **Raising the ceiling to a new minor**: update `engines.dsh`, the mirrored
  peer, the literal assertion in [test/manifest.test.js](../test/manifest.test.js),
  and this document in the same commit. Do not use `*` or an unbounded
  `>=` range; they silently accept breaking future releases.
- **Lowering the floor**: requires a floor smoke test on the candidate release
  plus the matrix assertion change. Symbol audits alone are not sufficient.

## Escape hatch

An exact-version exemption lives in the profile's `compatibility.json` and is
managed by `dsh plugin allow-version` (or the Plugins page). It is keyed by
`plugin-name@version` plus the exact DSH version, requires explicit risk
acknowledgement, and applies to that pair only. Treat it as a temporary
workaround for an unsupported release, not as a substitute for widening the
range.
