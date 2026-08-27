import fs from "node:fs"
import path from "node:path"

import { buildIntegrityManifest, writeIntegrityManifest } from "./verify-agent-host-package.mjs"

const root = path.resolve(import.meta.dirname, "../..")
const targets = {
  "darwin-arm64": {
    source: "cognia-agent-macos-arm64",
    package: "agent-host-darwin-arm64",
    executable: "cognia-agent",
  },
  "linux-x64": {
    source: "cognia-agent-linux-x64",
    package: "agent-host-linux-x64",
    executable: "cognia-agent",
  },
  "win32-x64": {
    source: "cognia-agent-win-x64",
    package: "agent-host-win32-x64",
    executable: "cognia-agent.exe",
  },
}

const requested = process.argv.slice(2).filter((arg) => arg !== "--")
const selected = requested.length > 0 ? requested : Object.keys(targets)
for (const key of selected) {
  const target = targets[key]
  if (!target) throw new Error(`unknown agent host target: ${key}`)
  const source = path.join(root, "cli", "dist", "bin", target.source)
  const executable = path.join(source, target.executable)
  if (!fs.existsSync(executable)) {
    throw new Error(`missing ${path.relative(root, executable)}; run pnpm cli:build:binary first`)
  }
  const packageRoot = path.join(root, "packages", target.package)
  const destination = path.join(packageRoot, "bin")
  fs.rmSync(destination, { recursive: true, force: true })
  fs.cpSync(source, destination, { recursive: true, dereference: true })
  if (key !== "win32-x64") fs.chmodSync(path.join(destination, target.executable), 0o755)

  // Record the closure of what we just packaged. `verify-agent-host-package`
  // (wired as each package's `prepack`) enforces it in both directions, so a
  // later stray file or a mutated byte fails the pack instead of shipping.
  const manifest = buildIntegrityManifest(packageRoot, key)
  writeIntegrityManifest(packageRoot, manifest)
  const count = Object.keys(manifest.files).length
  process.stdout.write(
    `packaged ${key} host at ${path.relative(root, destination)} (${count} files recorded)\n`
  )
}
