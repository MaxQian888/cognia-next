import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const TARGETS = {
  "darwin-arm64": { packageDir: "agent-host-darwin-arm64", executable: "cognia-agent" },
  "linux-x64": { packageDir: "agent-host-linux-x64", executable: "cognia-agent" },
  "win32-x64": { packageDir: "agent-host-win32-x64", executable: "cognia-agent.exe" },
}

const REQUIRED_RESOURCES = [
  "sidecar/pi-extension/cognia-pi-extension.ts",
  "sidecar/pi-extension/integrity.json",
  "tree-sitter.wasm",
  "grammars/tree-sitter-python.wasm",
  "grammars/tree-sitter-rust.wasm",
  "grammars/tree-sitter-tsx.wasm",
  "grammars/tree-sitter-typescript.wasm",
]

function requireFile(root, file, purpose) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`missing ${path.relative(root, file)}; ${purpose}`)
  }
}

function requireExecutable(root, file, targetName) {
  if (targetName !== "win32-x64" && (fs.statSync(file).mode & 0o111) === 0) {
    throw new Error(`${path.relative(root, file)} is not executable`)
  }
}

export function verifyAgentHostPackage(root, targetName) {
  const target = TARGETS[targetName]
  if (!target) throw new Error(`unknown agent host target: ${targetName}`)
  const packageRoot = path.join(root, "packages", target.packageDir)
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
  const relativeExecutable = `bin/${target.executable}`
  if (manifest.bin?.["cognia-agent"] !== relativeExecutable) {
    throw new Error(`${target.packageDir} must expose ${relativeExecutable}`)
  }
  const executable = path.join(packageRoot, relativeExecutable)
  requireFile(
    root,
    executable,
    `run pnpm cli:build:binary and pnpm agent:host:package -- ${targetName}`
  )
  requireExecutable(root, executable, targetName)

  for (const [helperBaseName, purpose] of [
    ["cognia-external-agent-launcher", "external agent dispatch requires its native launcher"],
    ["cognia-task-workspace-worker", "worker dispatch requires Task Workspace"],
  ]) {
    const helperName = `${helperBaseName}${targetName === "win32-x64" ? ".exe" : ""}`
    const helper = path.join(packageRoot, "bin", helperName)
    requireFile(root, helper, purpose)
    requireExecutable(root, helper, targetName)
  }

  for (const relativeResource of REQUIRED_RESOURCES) {
    requireFile(
      root,
      path.join(packageRoot, "bin", relativeResource),
      "the Bun standalone host requires its adjacent runtime resources"
    )
  }
  return executable
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "../..")
  const targetName = process.argv[2]
  verifyAgentHostPackage(root, targetName)
  process.stdout.write(`verified ${targetName} agent host package\n`)
}
