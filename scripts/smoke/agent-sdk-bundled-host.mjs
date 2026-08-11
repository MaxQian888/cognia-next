import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../..")
const target = process.argv[2] ?? `${process.platform}-${process.arch}`
const packageName = `agent-host-${target}`
const packageRoot = path.join(root, "packages", packageName)
if (!fs.existsSync(packageRoot)) throw new Error(`unsupported agent host target: ${target}`)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-bundled-host-"))
try {
  const pack = (cwd) => {
    const result = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", tempRoot], {
        cwd,
        encoding: "utf8",
      })
    )
    return path.join(tempRoot, result[0].filename)
  }
  const hostTarball = pack(packageRoot)
  const sdkTarball = pack(path.join(root, "packages", "agent"))
  const consumer = path.join(tempRoot, "consumer")
  fs.mkdirSync(consumer)
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "agent-bundled-host-smoke", private: true, type: "module" })
  )
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", sdkTarball, hostTarball],
    { cwd: consumer, stdio: "inherit" }
  )
  fs.writeFileSync(
    path.join(consumer, "smoke.mjs"),
    `import { createCogniaClient } from "@cognia/agent";
const client = await createCogniaClient({ host: { kind: "bundled", startupTimeoutMs: 30000 } });
try {
  const status = await client.runtime.status();
  if (status.status !== "ready") throw new Error("bundled host did not become ready");
} finally {
  await client.close();
}
`
  )
  const smoke = spawnSync(process.execPath, [path.join(consumer, "smoke.mjs")], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 60_000,
  })
  if (smoke.status !== 0) {
    throw new Error(
      `bundled host smoke failed (${smoke.status ?? "signal"})\n${smoke.stdout}\n${smoke.stderr}`
    )
  }
  process.stdout.write(`Agent SDK bundled ${target} host smoke passed\n`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
