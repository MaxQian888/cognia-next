import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { detectRipgrep, runRipgrep, __resetRgCache } from "./rg.mjs"

test("detectRipgrep honours COGNIA_RG_PATH when it exists", async () => {
  __resetRgCache()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rg-"))
  const fake = path.join(dir, "rg-fake")
  await fsp.writeFile(fake, "")
  const prev = process.env.COGNIA_RG_PATH
  process.env.COGNIA_RG_PATH = fake
  try {
    assert.equal(await detectRipgrep(), fake)
  } finally {
    if (prev === undefined) delete process.env.COGNIA_RG_PATH
    else process.env.COGNIA_RG_PATH = prev
    __resetRgCache()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("detectRipgrep result is cached and never undefined", async () => {
  __resetRgCache()
  const first = await detectRipgrep()
  const second = await detectRipgrep()
  assert.equal(first, second)
  assert.notEqual(first, undefined)
  __resetRgCache()
})

test("runRipgrep rejects when the binary path does not exist", async () => {
  await assert.rejects(
    runRipgrep(["--version"], { rgPath: path.join(os.tmpdir(), "definitely-missing-rg-bin") }),
    /ENOENT|not available|spawn/
  )
})

// Integration coverage when rg actually exists on the machine.
test("runRipgrep finds matches in a fixture dir (when rg available)", async (t) => {
  __resetRgCache()
  const bin = await detectRipgrep()
  if (!bin) {
    t.skip("ripgrep not installed on this machine")
    return
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rg-fix-"))
  try {
    await fsp.writeFile(path.join(dir, "a.txt"), "hello needle world\n")
    await fsp.writeFile(path.join(dir, "b.txt"), "nothing here\n")
    const { stdout, code } = await runRipgrep(["--no-config", "-n", "needle", "."], { cwd: dir })
    assert.equal(code, 0)
    assert.match(stdout, /a\.txt:1:hello needle world/)

    const none = await runRipgrep(["--no-config", "-n", "absent_zzz", "."], { cwd: dir })
    assert.equal(none.code, 1)
    assert.equal(none.stdout, "")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
    __resetRgCache()
  }
})
