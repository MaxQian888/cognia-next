// Test artifacts have immutable generations: a rebuilding worker must not
// replace chunks that another CLI or PTY process is still importing.
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import {
  isBuildCacheFresh,
  readBuildCache,
  saveBuildCache,
  writeIfChanged,
} from "./esbuild-input-cache.mjs"

const self = fileURLToPath(import.meta.url)
const generationPattern = /^generation-[0-9a-f-]{36}$/

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

async function lock(directory) {
  const token = randomUUID()
  const ownerFile = path.join(directory, "owner.json")
  const deadline = Date.now() + 240_000
  for (;;) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for test bundle lock: ${directory}`)
    try {
      fs.mkdirSync(directory)
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }))
      return () => {
        if (readBuildCache(ownerFile)?.token === token)
          fs.rmSync(directory, { recursive: true, force: true })
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    const owner = readBuildCache(ownerFile)
    // Keep a nonempty tombstone for a dead owner's unique token. Every stale
    // waiter renames to that SAME occupied directory, so a late waiter cannot
    // move or remove a newly acquired lock. Never unlink a check-then-rm lock.
    // An ownerless mkdir/write gap waits; it is not proof of a dead writer.
    if (owner && generationPattern.test(`generation-${owner.token}`) && !alive(owner.pid)) {
      try {
        fs.renameSync(directory, path.join(path.dirname(directory), `retired-${owner.token}`))
      } catch (error) {
        if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) throw error
      }
      continue
    }
    await delay(30)
  }
}

export function bundleFiles(directory) {
  const result = []
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) visit(file)
      else {
        const stat = fs.lstatSync(file)
        if (!stat.isFile()) throw new Error(`Test bundle contains a non-regular file: ${file}`)
        result.push([path.relative(directory, file), stat.mode & 0o777])
      }
    }
  }
  visit(directory)
  return result.sort(([a], [b]) => a.localeCompare(b))
}

function collect(parent, root, kind, current) {
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !generationPattern.test(entry.name) || entry.name === current)
      continue
    const directory = path.join(parent, entry.name)
    const marker = readBuildCache(path.join(directory, "owner.json"))
    if (marker?.root !== root || marker.kind !== kind || marker.schema !== 1) continue
    const leases = path.join(directory, "leases")
    if (fs.existsSync(leases) && fs.readdirSync(leases).some((pid) => alive(Number(pid)))) continue
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// Preserve /cli/dist/ path semantics and CLI-only npm resolution. A shallow
// generation also keeps the existing bounded sidecar/grammar walk-ups valid.
function runtimeLayout(root, directory, create) {
  const manifest = path.join(root, "cli/package.json")
  const copied = path.join(directory, "cli/package.json")
  if (create && fs.existsSync(manifest)) fs.copyFileSync(manifest, copied)
  for (const relative of ["cli/node_modules", "runtime"]) {
    const source = path.join(root, relative)
    if (!fs.existsSync(source)) continue
    const target = path.join(directory, relative)
    if (create) fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir")
    else {
      try {
        if (path.resolve(path.dirname(target), fs.readlinkSync(target)) !== source) return false
      } catch {
        return false
      }
    }
  }
  return true
}

/** Reuse content-verified outputs, serializing writers across Jest workers. */
export async function ensureTestBundle({
  root,
  kind,
  entryName,
  key,
  prepare,
  build,
  force = false,
  ownerPid = process.ppid,
}) {
  root = path.resolve(root)
  if (
    !["cli", "pty"].includes(kind) ||
    path.basename(entryName) !== entryName ||
    !alive(ownerPid)
  ) {
    throw new Error("Invalid test bundle kind, entry or reader process")
  }
  const parent = path.join(root, `.cache/jest/test-bundles-${kind}`)
  fs.mkdirSync(parent, { recursive: true })
  const release = await lock(path.join(parent, "lock"))
  const currentFile = path.join(parent, "current.json")
  key = JSON.stringify([key, process.version, process.platform, process.arch])
  try {
    await prepare?.()
    let current = readBuildCache(currentFile)
    let directory = generationPattern.test(current?.generation ?? "")
      ? path.join(parent, current.generation)
      : undefined
    let fresh = false
    if (!force && directory && fs.existsSync(path.join(directory, "cli/dist"))) {
      const outdir = path.join(directory, "cli/dist")
      fresh =
        runtimeLayout(root, directory, false) &&
        JSON.stringify(bundleFiles(outdir)) === JSON.stringify(current.files) &&
        isBuildCacheFresh(readBuildCache(path.join(directory, "cache.json")), root, key, [
          path.join(outdir, entryName),
        ])
    }
    if (!fresh) {
      directory = path.join(parent, `generation-${randomUUID()}`)
      const outdir = path.join(directory, "cli/dist")
      fs.mkdirSync(outdir, { recursive: true })
      fs.writeFileSync(
        path.join(directory, "owner.json"),
        JSON.stringify({ schema: 1, root, kind })
      )
      try {
        const startedAt = Date.now()
        runtimeLayout(root, directory, true)
        const { inputs, extraFiles = [] } = await build(outdir)
        const files = bundleFiles(outdir)
        if (!files.some(([file]) => file === entryName))
          throw new Error(`Test bundle entry is missing: ${entryName}`)
        saveBuildCache(path.join(directory, "cache.json"), {
          root,
          key,
          inputs,
          extraFiles: [self, path.join(root, "cli/package.json"), ...extraFiles],
          outputs: [
            ...files.map(([file]) => path.join(outdir, file)),
            ...(fs.existsSync(path.join(directory, "cli/package.json"))
              ? [path.join(directory, "cli/package.json")]
              : []),
          ],
          startedAt,
        })
        current = { generation: path.basename(directory), files }
        writeIfChanged(currentFile, JSON.stringify(current))
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true })
        throw error
      }
    }
    const leases = path.join(directory, "leases")
    fs.mkdirSync(leases, { recursive: true })
    fs.writeFileSync(path.join(leases, String(ownerPid)), "")
    collect(parent, root, kind, current.generation)
    return path.join(directory, "cli/dist", entryName)
  } finally {
    release()
  }
}
