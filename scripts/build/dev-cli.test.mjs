import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

// Copy the real runner into an isolated tree; build is a no-op and the child
// models the CLI consuming terminal SIGINT while an interactive command exits.
for (const launcher of ["node", "pnpm", "interruptible-parent"])
  test(
    `${launcher} dev runner stays alive when its CLI handles foreground-group SIGINT`,
    { skip: process.platform === "win32", timeout: 10000 },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "cognia-dev-sigint-"))
      mkdirSync(path.join(root, "scripts/build"), { recursive: true })
      mkdirSync(path.join(root, "cli/dist"), { recursive: true })
      writeFileSync(
        path.join(root, "scripts/build/dev-cli.mjs"),
        `process.on("exit", code => console.log("RUNNER_EXIT:" + code));\n` +
          readFileSync(new URL("./dev-cli.mjs", import.meta.url), "utf8")
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
      // Model a package manager that exits on SIGINT while the runner keeps
      // its inherited output pipes open; exercise this race on every POSIX host.
      writeFileSync(
        path.join(root, "launcher.mjs"),
        `import { spawn } from "node:child_process";
         spawn(process.execPath, ["scripts/build/dev-cli.mjs"], { stdio: "inherit" });`
      )
      const child = spawn(
        launcher === "pnpm" ? "pnpm" : process.execPath,
        launcher === "pnpm"
          ? ["run", "cli:dev"]
          : [path.join(root, launcher === "node" ? "scripts/build/dev-cli.mjs" : "launcher.mjs")],
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
          child.on("close", (code, signal) => resolve({ code, signal }))
        )
        // pnpm may terminate on SIGINT on Linux before its inherited-pipe
        // descendants finish. Wait for close and verify the actual runner's
        // completion independently of that package-manager exit status.
        assert.match(output, /CLI_RESUMED/)
        assert.match(output, /RUNNER_EXIT:7/)
        if (launcher === "interruptible-parent" || (launcher === "pnpm" && process.platform === "linux" && result.signal === "SIGINT")) {
          assert.equal(result.signal, "SIGINT")
          assert.equal(result.code, null)
        } else {
          assert.equal(result.signal, null)
          assert.equal(result.code, 7)
        }
      } finally {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
