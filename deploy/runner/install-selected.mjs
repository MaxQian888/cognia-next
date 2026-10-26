#!/usr/bin/env node

// Runner-only adapter for bundle shims. The project sandbox has its own
// cognia-sandboxd command dispatch; legacy RunnerSpec still launches npx.
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ALIASES = {
  "@zed-industries/codex-acp": "@agentclientprotocol/codex-acp",
  "@zed-industries/claude-code-acp": "@agentclientprotocol/claude-agent-acp",
}

function packageName(spec) {
  const match = spec?.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@(.*))?$/)
  return match ? (PACKAGE_ALIASES[match[1]] ?? match[1]) : undefined
}

// Parse only the prefix forms this Runner supports. In selected images,
// unparsed npm flags must never pass through: npm accepts abbreviations and
// negated boolean spellings that can override a prepended --offline.
function parseNpxPrefix(args, { strict = true } = {}) {
  const packages = []
  const addPackage = (value) => {
    if (strict && (value.startsWith("=") || value.includes(":"))) {
      throw new Error(
        `unsupported selected Runner npx package source ${value}; use a package name directly`
      )
    }
    packages.push(value)
  }
  let index = 0
  for (; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--") {
      index += 1
      break
    }
    if (!arg.startsWith("-")) break
    if (["-y", "--yes", "--no-install", "--offline"].includes(arg)) {
      if (["true", "false"].includes(args[index + 1])) {
        if (arg === "--offline" && args[index + 1] !== "true") {
          if (!strict) return undefined
          throw new Error("selected Runner project npx must stay offline")
        }
        index += 1
      }
      continue
    }
    if (/^--yes=(?:true|false)$/.test(arg) || arg === "--offline=true") continue
    if (arg === "-p" || arg === "--package") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a package`)
      addPackage(value)
      index += 1
      continue
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length)
      if (!value) throw new Error("--package requires a package")
      addPackage(value)
      continue
    }
    if (arg.startsWith("-p") && arg.length > 2) {
      addPackage(arg.slice(2))
      continue
    }
    if (!strict) return undefined
    if (/^--(?:no-)?offline(?:=|$)/.test(arg)) {
      throw new Error("selected Runner project npx must stay offline")
    }
    throw new Error(`unsupported selected Runner npx option ${arg}; run the project tool directly`)
  }
  return { spec: args[index], args: args.slice(index + 1), packages }
}

function installedCommand(spec, pins) {
  const match = spec?.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@(.*))?$/)
  if (!match || match[1].startsWith("-")) return undefined
  const name = packageName(spec)
  return pins.runtimes
    .flatMap((runtime) => runtime.commands ?? [])
    .find((entry) => entry.package === name || entry.name === match[1])
}

export function resolveNpx(args, pins, packageJson) {
  const parsed = parseNpxPrefix(args)
  const { spec } = parsed
  if (!spec || parsed.packages.length > 0)
    throw new Error("npx requires an installed Agent package directly")
  const match = spec.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@(.*))?$/)
  if (!match) throw new Error(`invalid Agent package ${spec}`)
  const command = installedCommand(spec, pins)
  const name = command?.package ?? packageName(spec)
  const version = packageJson.dependencies?.[name]
  if (!version || !command)
    throw new Error(
      `Agent package ${name} is not installed in this Runner; rebuild with AGENT_RUNTIMES`
    )
  if (match[2] !== undefined && match[2] !== version)
    throw new Error(`Agent package ${name} is frozen at ${version}, requested ${match[2]}`)
  return { command: command.name, args: parsed.args }
}

export function resolveNpxInvocation(
  args,
  pins,
  packageJson,
  { knownPackages, knownCommands = [], full = false, nativeNpx, commandsDir }
) {
  // Parse npm options only before the package: subsequent flags belong to
  // the Agent/project CLI and cannot override native npx's offline prefix.
  const parsed = parseNpxPrefix(args, { strict: !full })
  if (!full && parsed?.spec?.includes(":")) {
    throw new Error(
      `unsupported selected Runner npx package source ${parsed.spec}; use a package name directly`
    )
  }
  if (parsed && parsed.packages.length === 0 && installedCommand(parsed.spec, pins)) {
    const result = resolveNpx(args, pins, packageJson)
    return { path: join(commandsDir, result.command), args: result.args }
  }
  // Project tools can use native npx offline. Known Agent names and -p package
  // forms cannot reach npm's local/cache resolution and evade frozen dispatch.
  if (!full && parsed) {
    for (const spec of [parsed.spec, ...parsed.packages]) {
      const name = packageName(spec)
      if (knownPackages.includes(name) || knownCommands.includes(name)) {
        throw new Error(
          `Agent package ${spec} is not installed for this npx invocation; use npx <selected-package> or rebuild with AGENT_RUNTIMES`
        )
      }
    }
  }
  if (!nativeNpx) throw new Error("this custom Runner base has no native npx for project tools")
  return { path: nativeNpx, args: full ? args : ["--offline", ...args] }
}

export function validateBase(pins, { node, libc, arch }) {
  if (node !== pins.node.version)
    throw new Error(`Runner requires Node ${pins.node.version}, found ${node}`)
  const canonicalArch = { x64: "amd64", amd64: "amd64", arm64: "arm64" }[arch]
  if (!canonicalArch) throw new Error(`unsupported Runner architecture ${arch}`)
  const floor = Math.max(
    Number(pins.node.minGlibc.split(".")[1]),
    ...pins.runtimes.map((runtime) =>
      Number((runtime.minGlibc?.[canonicalArch] ?? "2.0").split(".")[1])
    )
  )
  if (!/^2\.\d+$/.test(libc ?? "") || Number(libc.split(".")[1]) < floor) {
    throw new Error(
      `custom Runner base requires glibc >=2.${floor}; musl and older glibc bases are unsupported`
    )
  }
}

export function resolveNativeNpx(nativeNpx, wrapper) {
  if (!nativeNpx) return null
  const executable = isAbsolute(nativeNpx) ? nativeNpx : `${process.cwd()}/${nativeNpx}`
  if (realpathSync.native(executable) === realpathSync.native(wrapper)) {
    throw new Error("native npx resolves to the Runner wrapper; choose a base with native npm")
  }
  // Preserve argv[0] and POSIX symlink/.. traversal used by toolchain managers.
  return executable
}

export function installRunnerShims({
  pins,
  packageJson,
  root = "/cognia",
  nodePath = "/cognia/glibc/node/bin/node",
  commandsDir = join(root, "glibc", "bin"),
  knownPackages = Object.keys(packageJson.dependencies),
  knownCommands = pins.runtimes.flatMap(
    (runtime) => runtime.commands?.map((command) => command.name) ?? []
  ),
  nativeNpx = "/usr/local/bin/npx",
  full = false,
}) {
  const dir = join(root, "runner")
  mkdirSync(join(dir, "bin"), { recursive: true })
  copyFileSync(fileURLToPath(import.meta.url), join(dir, "install-selected.mjs"))
  writeFileSync(
    join(dir, "agent-selection.json"),
    `${JSON.stringify({ pins, packageJson, knownPackages, knownCommands, nativeNpx, full }, null, 2)}\n`
  )
  // execve retains PID 1 and signal semantics of a direct agent launch. There
  // is deliberately no npm download fallback, even when the network is up.
  writeFileSync(
    join(dir, "bin", "npx"),
    `#!${nodePath}
import { readFileSync } from "node:fs"
import { resolveNpxInvocation } from "../install-selected.mjs"
try {
  const { pins, packageJson, ...options } = JSON.parse(readFileSync(new URL("../agent-selection.json", import.meta.url), "utf8"))
  const { path, args } = resolveNpxInvocation(process.argv.slice(2), pins, packageJson, { ...options, commandsDir: ${JSON.stringify(commandsDir)} })
  process.execve(path, [path, ...args], process.env)
} catch (error) {
  console.error("cognia-runner: " + error.message)
  process.exitCode = 1
}
`,
    { mode: 0o755 }
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, pinsPath, packagePath, masterPackagePath, masterPinsPath] = process.argv.slice(2)
    const input = JSON.parse(readFileSync(pinsPath, "utf8"))
    const pins = input.pins ?? input
    if (mode === "check-base" || mode === "configure-base") {
      validateBase(pins, {
        node: process.versions.node,
        libc: process.report.getReport().header.glibcVersionRuntime,
        arch: process.arch,
      })
      if (mode === "configure-base") {
        input.nativeNpx = resolveNativeNpx(
          process.env.COGNIA_NATIVE_NPX,
          join(dirname(resolve(pinsPath)), "bin", "npx")
        )
        writeFileSync(pinsPath, `${JSON.stringify(input, null, 2)}\n`)
      }
    } else if (mode === "install" || mode === "install-full") {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"))
      if (mode === "install-full") {
        for (const name of Object.keys(packageJson.dependencies)) {
          packageJson.dependencies[name] = JSON.parse(
            readFileSync(join(process.env.COGNIA_GLOBAL_NODE_MODULES, name, "package.json"), "utf8")
          ).version
        }
        for (const runtime of pins.runtimes) {
          if (runtime.commands)
            runtime.version = packageJson.dependencies[runtime.commands[0].package]
        }
      }
      installRunnerShims({
        pins,
        packageJson,
        knownPackages: [
          ...Object.keys(
            JSON.parse(readFileSync(masterPackagePath ?? packagePath, "utf8")).dependencies
          ),
          "cline",
        ],
        knownCommands: JSON.parse(
          readFileSync(masterPinsPath ?? pinsPath, "utf8")
        ).runtimes.flatMap((runtime) => [
          ...(runtime.commands ?? []).map((command) => command.name),
          ...[runtime.archive?.command, runtime.binary?.command].filter(Boolean),
        ]),
        nativeNpx: process.env.COGNIA_NATIVE_NPX ?? "/usr/local/bin/npx",
        ...(mode === "install-full"
          ? { nodePath: process.execPath, commandsDir: "/usr/local/bin", full: true }
          : {}),
      })
    } else throw new Error(`unknown mode ${mode}`)
  } catch (error) {
    console.error(`cognia-runner: ${error.message}`)
    process.exitCode = 1
  }
}
