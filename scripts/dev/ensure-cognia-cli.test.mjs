import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildCogniaCli } from "./ensure-cognia-cli.mjs"

const script = fileURLToPath(new URL("./ensure-cognia-cli.mjs", import.meta.url))

async function fakeCargo(t, exitCode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cognia-ensure-cli-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const log = path.join(dir, "calls.log")
  const cargo = path.join(dir, "cargo")
  await writeFile(
    cargo,
    `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = "--version" ] && exit 0\nexit ${exitCode}\n`
  )
  await chmod(cargo, 0o755)
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH }
  delete env.COGNIA_SKIP_CLI_BUILD
  delete env.TAURI_ENV_PLATFORM
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
  return { env, calls }
}

test("builds the CLI with cargo", { skip: process.platform === "win32" }, async (t) => {
  const { env, calls } = await fakeCargo(t, 0)
  buildCogniaCli(env)
  assert.deepEqual(await calls(), ["--version", "build -p cognia-cli"])
})

test(
  "a failed build is reported, not thrown",
  { skip: process.platform === "win32" },
  async (t) => {
    const { env, calls } = await fakeCargo(t, 101)
    assert.doesNotThrow(() => buildCogniaCli(env))
    assert.deepEqual(await calls(), ["--version", "build -p cognia-cli"])
  }
)

test(
  "COGNIA_SKIP_CLI_BUILD=1 skips cargo entirely",
  { skip: process.platform === "win32" },
  async (t) => {
    const { env, calls } = await fakeCargo(t, 0)
    buildCogniaCli({ ...env, COGNIA_SKIP_CLI_BUILD: "1" })
    assert.deepEqual(await calls(), [])
  }
)

test(
  "importing the module runs nothing; the predev entry is a no-op outside tauri dev",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const { env, calls } = await fakeCargo(t, 0)
    const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(await calls(), [])

    const underTauri = spawnSync(process.execPath, [script], {
      env: { ...env, TAURI_ENV_PLATFORM: "darwin" },
      encoding: "utf8",
    })
    assert.equal(underTauri.status, 0, underTauri.stderr)
    assert.deepEqual(await calls(), ["--version", "build -p cognia-cli"])
  }
)
