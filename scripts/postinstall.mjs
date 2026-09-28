// Root postinstall — sidecar deps, the compiled output of the workspace
// packages the sidecar links, and the VSCode ext-host sidecar bundle.
//
// Container/partial checkouts (the cognia-server brain-builder stage installs
// workspace deps BEFORE copying sidecar/ so the store-heavy layer caches)
// don't have sidecar/ yet — skip quietly there; the Dockerfile runs the
// sidecar install as its own later step. Local `pnpm install` behaves as
// before.
import fs from "node:fs"
import { execSync } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

// node-pty 1.1.0 ships its macOS spawn helper without the executable bit.
export function repairNodePtySpawnHelper(root, platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") return
  for (const relative of [`prebuilds/darwin-${arch}/spawn-helper`, "build/Release/spawn-helper"]) {
    const helper = path.join(root, relative)
    if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o100)
  }
}

function main() {
  if (process.platform === "darwin") {
    const require = createRequire(import.meta.url)
    let packagePath
    try {
      packagePath = require.resolve("node-pty/package.json")
    } catch (error) {
      // Production-only installs omit this development dependency.
      if (error.code !== "MODULE_NOT_FOUND") throw error
    }
    if (packagePath) repairNodePtySpawnHelper(path.dirname(packagePath))
  }

  if (!fs.existsSync("sidecar/package.json")) {
    console.log("postinstall: sidecar/ not present (container/partial checkout) — skipping")
    process.exit(0)
  }

  execSync("pnpm run sidecar:install", { stdio: "inherit" })
  execSync("node scripts/build/build-sidecar-linked-packages.mjs", { stdio: "inherit" })
  execSync("node scripts/build/build-a2ui-sidecar.mjs", { stdio: "inherit" })
  execSync("pnpm run sidecar:vscode:build", { stdio: "inherit" })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
