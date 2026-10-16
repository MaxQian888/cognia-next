import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { stageManagedDesktopContext, verifyGuestExecutable } from "./managed-desktop-context.mjs"

function elf() {
  const bytes = Buffer.alloc(120)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes)
  bytes.writeUInt16LE(2, 16)
  bytes.writeUInt16LE(62, 18)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(1, 56)
  bytes.writeUInt32LE(1, 64)
  bytes.writeUInt32LE(5, 68)
  return bytes
}

test("rejects wrong platform, architecture, dynamic loader and malformed headers", () => {
  assert.doesNotThrow(() => verifyGuestExecutable(elf()))
  for (const change of [
    b => { b[0] = 0 }, b => { b[5] = 2 }, b => b.writeUInt16LE(183, 18),
    b => b.writeUInt32LE(3, 64), b => b.writeBigUInt64LE(999999n, 32),
    b => b.writeUInt16LE(0, 56), b => b.writeUInt32LE(4, 68),
  ]) {
    const bytes = elf(); change(bytes)
    assert.throws(() => verifyGuestExecutable(bytes))
  }
  assert.throws(() => verifyGuestExecutable(Buffer.alloc(20)))
})

test("stages only reviewed inputs and an executable; refuses replacement and symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-context-"))
  try {
    const binary = join(root, "guest")
    writeFileSync(binary, elf(), { mode: 0o755 })
    const output = join(root, "context")
    stageManagedDesktopContext(binary, output)
    assert.deepEqual(readFileSync(join(output, "cognia-desktop-guest")), elf())
    assert.match(readFileSync(join(output, "Dockerfile"), "utf8"), /COPY --chmod=0755 cognia-desktop-guest/)
    assert.match(readFileSync(join(output, "Dockerfile"), "utf8"), /COPY --chmod=0444 handoff-import.py/ )
    assert.match(readFileSync(join(output, "handoff-import.py"), "utf8"), /def import_source/ )
    assert.throws(() => stageManagedDesktopContext(binary, output))
    const link = join(root, "link")
    symlinkSync(binary, link)
    assert.throws(() => stageManagedDesktopContext(link, join(root, "bad")))
    chmodSync(binary, 0o644)
    assert.throws(() => stageManagedDesktopContext(binary, join(root, "nonexec")))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
