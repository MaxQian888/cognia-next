#!/usr/bin/env node
// Compose the managed image without changing the embedded Docker build context.
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const IMAGE = "crates/cognia-automation/src/cua_sandbox/image"
const INPUTS = ["Dockerfile", "entrypoint.sh", "startup.py", "server.py", "menu.xml"]

export function verifyGuestExecutable(bytes) {
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 ||
    ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== 62
  ) {
    throw new Error("Guest must be a Linux amd64 ELF executable")
  }
  const offset = Number(bytes.readBigUInt64LE(32))
  const size = bytes.readUInt16LE(54)
  const count = bytes.readUInt16LE(56)
  if (!Number.isSafeInteger(offset) || offset < 64 || size !== 56 || count === 0 ||
      offset + count * size > bytes.length) {
    throw new Error("Guest ELF program headers are invalid")
  }
  let executableLoad = false
  for (let i = 0; i < count; i++) {
    const at = offset + i * size
    const kind = bytes.readUInt32LE(at)
    if (kind === 3) throw new Error("Guest must be statically linked for the pinned image")
    if (kind === 1 && (bytes.readUInt32LE(at + 4) & 1)) executableLoad = true
  }
  if (!executableLoad) throw new Error("Guest ELF has no executable load segment")
}

export function stageManagedDesktopContext(binary, output, root = ROOT) {
  const info = lstatSync(binary)
  if (!info.isFile() || info.size > 128 * 1024 * 1024 || !(info.mode & 0o111)) {
    throw new Error("Guest binary must be a bounded executable regular file")
  }
  const bytes = readFileSync(binary)
  verifyGuestExecutable(bytes)
  // Require a new destination. Never replace another session's staged context.
  mkdirSync(output, { recursive: false })
  for (const name of INPUTS) copyFileSync(join(root, IMAGE, name), join(output, name))
  writeFileSync(join(output, "cognia-desktop-guest"), bytes, { mode: 0o755, flag: "wx" })
  const dockerfile = readFileSync(join(output, "Dockerfile"), "utf8")
  writeFileSync(join(output, "Dockerfile"), `${dockerfile}\nCOPY --chmod=0755 cognia-desktop-guest /usr/local/bin/cognia-desktop-guest\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Usage: managed-desktop-context.mjs <static-binary> <new-context>")
  stageManagedDesktopContext(resolve(process.argv[2]), resolve(process.argv[3]))
}
