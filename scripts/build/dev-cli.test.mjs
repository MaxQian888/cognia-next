import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

// Copy the real runner into an isolated tree; build is a no-op and the child
// models the CLI consuming terminal SIGINT while an interactive command exits.
for (const launcher of ["node", "pnpm"])
  test(
    `${launcher} dev runner stays alive when its CLI handles foreground-group SIGINT`,
    { skip: process.platform === "win32", timeout: 10000 },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "cognia-dev-sigint-"))
      mkdirSync(path.join(root, "scripts/build"), { recursive: true })
      mkdirSync(path.join(root, "cli/dist"), { recursive: true })
      copyFileSync(
        new URL("./dev-cli.mjs", import.meta.url),
        path.join(root, "scripts/build/dev-cli.mjs")
      )
      writeFileSync(path.join(root, "scripts/build/build-cli.mjs"), "")
      writeFileSync(
        path.join(root, "cli/dist/cognia-agent.mjs"),
        `
    process.on("SIGINT", () => setTimeout(() => { console.log("CLI_RESUMED"); process.exit(7) }, 200));
    console.log("CLI_READY");
    setInterval(() => {}, 1000);
  `
      )
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { "cli:dev": "node scripts/build/dev-cli.mjs" } })
      )
      const child = spawn(
        launcher === "node" ? process.execPath : "pnpm",
        launcher === "node" ? [path.join(root, "scripts/build/dev-cli.mjs")] : ["run", "cli:dev"],
        { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] }
      )
      let output = ""
      let sent = false
      child.stdout.on("data", (chunk) => {
        output += chunk.toString()
        if (!sent && output.includes("CLI_READY")) {
          sent = true
          process.kill(-child.pid, "SIGINT")
        }
      })
      try {
        const result = await new Promise((resolve) =>
          child.on("exit", (code, signal) => resolve({ code, signal }))
        )
        assert.equal(result.signal, null)
        assert.equal(result.code, 7)
        assert.match(output, /CLI_RESUMED/)
      } finally {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
