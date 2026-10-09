import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import type { TestContext } from "node:test"

import {
  appServerChildren,
  parseCommonOptions,
  relayPaths,
  resolveCodexAppCli,
  waitFor,
  workerPath,
} from "./shared.ts"

function bundleFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-runtime-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const appPath = join(root, "Codex App.app")
  const paths = {
    native: join(appPath, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
    launcher: join(appPath, "Contents/Resources/codex-cli/bin/codex"),
    legacy: join(appPath, "Contents/Resources/codex"),
  }
  const install = (path: string, mode = 0o755) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode })
    chmodSync(path, mode)
    return path
  }
  return { appPath, paths, install }
}

test("CLI discovery supports the current native runtime and launcher layout", (t) => {
  const fixture = bundleFixture(t)
  fixture.install(fixture.paths.native)
  fixture.install(fixture.paths.launcher)
  fixture.install(fixture.paths.legacy)
  assert.equal(resolveCodexAppCli(fixture.appPath), fixture.paths.native)
  rmSync(fixture.paths.native)
  assert.equal(resolveCodexAppCli(fixture.appPath), fixture.paths.launcher)
})

test("CLI discovery falls back to the legacy executable and rejects missing runtimes", (t) => {
  const fixture = bundleFixture(t)
  fixture.install(fixture.paths.native, 0o644)
  mkdirSync(fixture.paths.launcher, { recursive: true })
  fixture.install(fixture.paths.legacy)
  assert.equal(resolveCodexAppCli(fixture.appPath), fixture.paths.legacy)
  rmSync(fixture.paths.legacy)
  assert.throws(() => resolveCodexAppCli(fixture.appPath), /No executable bundled Codex CLI found/)
})

test("common flags discover the CLI inside the selected App without overriding an explicit CLI", (t) => {
  const fixture = bundleFixture(t)
  fixture.install(fixture.paths.native)
  assert.equal(parseCommonOptions(["--app-path", fixture.appPath]).realCli, fixture.paths.native)
  assert.equal(
    parseCommonOptions(["--real-cli", "/custom/codex", "--app-path", fixture.appPath]).realCli,
    "/custom/codex"
  )
})

test("App Server discovery accepts current and legacy bundled direct children", (t) => {
  const { appPath, paths } = bundleFixture(t)
  const commands = [
    `201 101 ${paths.native} -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools.enabled=true`,
    `202 101 ${paths.legacy} app-server -c features.code_mode_host=true`,
    `203 101 ${paths.native} exec-server --remote https://example.test`,
    `204 102 ${paths.native} app-server`,
    `205 101 ${paths.native} app-server --listen stdio://`,
    `206 101 ${paths.native} app-server --listen=unix:///tmp/codex.sock`,
    `207 101 ${paths.native}-other app-server`,
    `208 101 /custom/relay-shim app-server`,
    `209 101 ${paths.native} -c app-server exec-server`,
  ]
  const children = appServerChildren({ appPids: [101], realCli: paths.launcher, appPath }, () => ({
    ok: true,
    status: 0,
    signal: null,
    stdout: commands.join("\n"),
    stderr: "",
    error: null,
  }))
  assert.deepEqual(
    children.map((child) => child.pid),
    [201, 202]
  )
  assert.equal(children[0]?.ppid, 101)
  assert.equal(children[0]?.command, commands[0]?.replace(/^\d+ \d+ /, ""))
})

test("relayPaths names the relaunch result and logs under the state dir", () => {
  assert.deepEqual(relayPaths("/state"), {
    root: "/state",
    cdpOnlyRelaunchResult: "/state/cdp-only-relaunch-result.json",
    cdpOnlyRelaunchStdout: "/state/cdp-only-relaunch-worker.stdout.log",
    cdpOnlyRelaunchStderr: "/state/cdp-only-relaunch-worker.stderr.log",
  })
})

test("workerPath resolves the launchd-spawned scripts next to this module", () => {
  assert.equal(
    workerPath("one-shot-launcher.mjs"),
    new URL("./one-shot-launcher.mjs", import.meta.url).pathname
  )
})

test("waitFor returns the first truthy value and names the condition on timeout", async () => {
  let calls = 0
  assert.equal(
    await waitFor(() => (++calls >= 2 ? "ready" : null), { timeoutMs: 1_000, intervalMs: 1 }),
    "ready"
  )
  await assert.rejects(
    waitFor(
      () => {
        throw new Error("probe failed")
      },
      { timeoutMs: 20, intervalMs: 5, description: "renderer" }
    ),
    /renderer did not become ready within 20ms: probe failed/
  )
})
