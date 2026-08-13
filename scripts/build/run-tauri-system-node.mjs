import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const BUNDLED_NODE_RESOURCE = "resources/plugin-node/**/*"

function withoutPluginNodePreparation(command) {
  return command
    .split("&&")
    .map((step) => step.trim())
    .filter((step) => step !== "pnpm plugin-node:prepare")
    .join(" && ")
}

export function createSystemNodeOverride(config) {
  const resources = config.bundle?.resources
  if (!Array.isArray(resources) || !resources.includes(BUNDLED_NODE_RESOURCE)) {
    throw new Error("Tauri base config does not contain the bundled Node resource")
  }

  return {
    build: {
      beforeBuildCommand: withoutPluginNodePreparation(config.build.beforeBuildCommand),
      beforeDevCommand: withoutPluginNodePreparation(config.build.beforeDevCommand),
    },
    bundle: {
      resources: resources.filter((resource) => resource !== BUNDLED_NODE_RESOURCE),
    },
  }
}

async function run(subcommand, forwardedArgs) {
  if (subcommand !== "build" && subcommand !== "dev") {
    throw new Error("Expected a Tauri subcommand: build or dev")
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"))
  const override = createSystemNodeOverride(config)
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  const args = [
    "exec",
    "tauri",
    subcommand,
    "--features",
    "system-node-runtime",
    "--config",
    JSON.stringify(override),
    ...forwardedArgs,
  ]

  await new Promise((resolveRun, reject) => {
    const child = spawn(pnpm, args, { cwd: root, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun()
      else reject(new Error(`Tauri system-node ${subcommand} failed (${signal ?? code})`))
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run(process.argv[2], process.argv.slice(3))
}
