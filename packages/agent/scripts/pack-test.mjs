import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dirname, "..")
const workspaceRoot = path.resolve(packageRoot, "../..")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-pack-"))

try {
  execFileSync(path.join(workspaceRoot, "node_modules/.bin/tsup"), [], {
    cwd: packageRoot,
    stdio: "inherit",
  })
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", tempRoot], {
      cwd: packageRoot,
      encoding: "utf8",
    })
  )
  const tarball = path.join(tempRoot, packed[0].filename)
  const consumer = path.join(tempRoot, "consumer")
  fs.mkdirSync(consumer)
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "agent-sdk-consumer", private: true, type: "module" })
  )
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", tarball],
    {
      cwd: consumer,
      stdio: "inherit",
    }
  )
  fs.writeFileSync(
    path.join(consumer, "esm.mjs"),
    'import { createCogniaClient } from "@cognia/agent"; if (typeof createCogniaClient !== "function") process.exit(1)\n'
  )
  fs.writeFileSync(
    path.join(consumer, "cjs.cjs"),
    'const { createCogniaClient } = require("@cognia/agent"); if (typeof createCogniaClient !== "function") process.exit(1)\n'
  )
  fs.writeFileSync(
    path.join(consumer, "types.ts"),
    'import type { CogniaClient } from "@cognia/agent"; import type { RpcMethodMap } from "@cognia/agent/protocol"; declare const client: CogniaClient; declare const map: RpcMethodMap; void client; void map\n'
  )
  fs.writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["types.ts"],
    })
  )
  execFileSync(process.execPath, [path.join(consumer, "esm.mjs")], { stdio: "inherit" })
  execFileSync(process.execPath, [path.join(consumer, "cjs.cjs")], { stdio: "inherit" })
  execFileSync(path.join(workspaceRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
    cwd: consumer,
    stdio: "inherit",
  })

  const packedFiles = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
  if (packedFiles.includes("src/") || packedFiles.includes("@/")) {
    throw new Error("packed SDK contains source files or unresolved app aliases")
  }
  console.log("@cognia/agent packed-consumer test passed")
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
