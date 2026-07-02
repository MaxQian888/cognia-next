// Root postinstall — sidecar deps + the VSCode ext-host sidecar bundle.
//
// Container/partial checkouts (the cognia-server brain-builder stage installs
// workspace deps BEFORE copying sidecar/ so the store-heavy layer caches)
// don't have sidecar/ yet — skip quietly there; the Dockerfile runs the
// sidecar install as its own later step. Local `pnpm install` behaves as
// before.
import fs from "node:fs"
import { execSync } from "node:child_process"

if (!fs.existsSync("sidecar/package.json")) {
  console.log("postinstall: sidecar/ not present (container/partial checkout) — skipping")
  process.exit(0)
}

execSync("pnpm run sidecar:install", { stdio: "inherit" })
execSync("pnpm run sidecar:vscode:build", { stdio: "inherit" })
