# Cognia-owned DeepSeek Harness runtime composition

This directory is **Cognia source**, versioned with Cognia — not a vendored copy of DeepSeek
Harness (DSH). It exists because DSH ships no runnable entry point for the two transports Cognia
integrates against.

## Why Cognia has to own this

DSH splits its Cordis composition into two planes:

- the **agent plane** (`agent.cordis.yml`) — persona, model-facing tools, tool presentation;
- the **host plane** — the registries themselves, the sandbox and approval stack, persistence,
  and the model route.

The published npm packages ship **only the agent plane** (four presets inside `@deepseek-ai/dsh`).
The host compositions (`base.cordis.yml` / `web.cordis.yml`) are referenced in upstream comments
but are not published. On top of that:

- `@deepseek-ai/dsh-acp` and `@deepseek-ai/dsh-sdk-client` both have `"bin": null` — they are
  Cordis plugin libraries, not executables.
- The one published binary, `@deepseek-ai/dsh` (`bin: dsh`), exposes only `web` and `plugin`
  subcommands and contains no ACP code at all.
- `@deepseek-ai/dsh-sdk-client` states plainly: _"No bundled-runtime resolution — callers name the
  runtime executable explicitly"_, with `{ command: 'node', args: ['lib/bin.js', 'cordis.yml'] }`
  as the reference launch spec.

So there is nothing to "install and launch by absolute path". Cognia must supply the host plane,
and that host plane is where the sandbox and approval stack live — i.e. it is security-critical
and belongs under review, not vendored.

## Contents

| File                     | Role                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| `host.sdk-readonly.yml`  | Default SDK profile. Sandbox mode `read-only`, no shell/terminal tools. |
| `host.sdk-workspace.yml` | SDK profile with `workspace-write` and pre-approved tooling.            |
| `launcher.mjs`           | Thin wrapper over `@deepseek-ai/dsh-app-boot`'s `boot()`.               |
| `package.json`           | Exact-pinned DSH dependency set for the isolated runtime home.          |

`launcher.mjs` passes `bareModuleBaseUrl` to `boot()`. Upstream documents that parameter as being
for exactly this case: _"a closed runtime passes `bareModuleBaseUrl` … so its installed package
tree remains authoritative even when the config lives inside another Node project."_

## Trust boundary: `DSH_HOME` must be pinned

`resolveDshHome()` resolves `$DSH_HOME`, else `~/.dsh`. Under that root, DSH reads user-writable
layers that are applied **after every bundle layer** and may `insert` arbitrary plugin rows and
evaluate arbitrary JavaScript via the `!!js` YAML tag:

- `$DSH_HOME/cordis.patch.yml`
- `$DSH_HOME/profiles/<name>/cordis.patch.yml`
- `$DSH_HOME/profiles/<name>/package.json` (out-of-tree plugin `dependencies`)

These are live-watched through `watchUserPatches` and recompose the tree transactionally at
runtime.

**If `DSH_HOME` were left at its default, a file in the user's home directory could mount write and
network tools onto Cognia's "certified read-only" profile while the lockfile and composition
digests still verified.** The launcher therefore refuses to start unless `DSH_HOME` points inside
the Cognia-owned runtime home, and `doctor` asserts no unplanned patch layer exists there.

## Native dependencies

`koffi` is a hard dependency of `@deepseek-ai/dsh-fs-local` (which `dsh-fs-sandbox` extends), but
it is imported only from an `async function win32()` path that loads `advapi32.dll` /
`kernel32.dll`. On macOS and Linux it is never imported, so it is installed but **not built**
(`--ignore-scripts`). Windows support would require building it.

`node-pty` (via `@deepseek-ai/dsh-subprocess-local`) is a _static_ top-level import, so any
composition that loads the local subprocess provider needs its native binding. Upstream ships
prebuilds for `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64` — **there is no Linux
prebuild**. The read-only profile avoids this by not composing a subprocess provider at all.

## Upstream version

Pinned to `0.1.0-rc.6`. DSH is a developer preview whose README warns of
compatibility-breaking changes, and whose `SESSION_FORMAT_VERSION` is `0` with no compatibility
promise. Version preflight keys on the installed npm package versions, never on the protocol
handshake: `dsh-sdk-protocol` documents _"No protocol-version negotiation — the handshake carries
only `serverInfo.version` (`0.0.1`, unvalidated by clients)"_.
