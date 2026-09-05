import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const SDK = "@anthropic-ai/claude-agent-sdk"

/** Resolve from the installed SDK, never an arbitrary version in pnpm's store. */
export function resolveClaudeRuntime({ root, packageName, platform = process.platform, arch = process.arch }) {
  const sdkDir = fs.realpathSync(path.join(root, "sidecar/node_modules", SDK))
  const manifest = JSON.parse(fs.readFileSync(path.join(sdkDir, "package.json"), "utf8"))
  const require = createRequire(path.join(sdkDir, "package.json"))
  const musl = platform === "linux" && process.platform === "linux" &&
    process.report?.getReport().header.glibcVersionRuntime === undefined
  const name = packageName ?? `${SDK}-${platform}-${arch}${musl ? "-musl" : ""}`
  const expectedVersion = manifest.optionalDependencies?.[name]
  if (!expectedVersion) throw new Error(`Claude SDK does not declare runtime ${name}`)
  let directory
  try {
    directory = path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    throw new Error(`Missing Claude runtime ${name}@${expectedVersion}; install the SDK optional dependencies for the target before packaging`)
  }
  const installed = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
  if (installed.version !== expectedVersion) {
    throw new Error(`Claude runtime ${name} version ${installed.version} does not match SDK requirement ${expectedVersion}`)
  }
  const binary = path.join(directory, name.includes("-win32-") ? "claude.exe" : "claude")
  if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing Claude executable ${binary}`)
  }
  return { name, directory, binary }
}

/** pnpm keeps optional deps beside the SDK, outside its recursively copied directory. */
export function stageClaudeRuntime({ nodeModulesDir, ...options }) {
  const runtime = resolveClaudeRuntime(options)
  const destination = path.join(nodeModulesDir, runtime.name)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(runtime.directory, destination, { recursive: true, dereference: true })
  return { ...runtime, destination }
}
