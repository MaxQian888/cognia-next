#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Only the root noEmit check opts into the pinned memory improvements. Other
// workspaces, emitting builds, the editor and Compiler API keep their toolchain.
export function resolveRootCompiler(root, platform = process.platform, arch = process.arch) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const require = createRequire(join(root, "package.json"))
  const packageName = `@typescript/typescript-${platform}-${arch}`
  const preview = Object.hasOwn(manifest.optionalDependencies ?? {}, packageName)
  const name = preview ? packageName : "@typescript/native"
  const version = preview
    ? manifest.optionalDependencies[packageName]
    : manifest.devDependencies?.[name]?.replace(/^npm:typescript@/, "")
  if (!/^7\.\d+\.\d+(?:-dev\.\d{8}\.\d+)?$/.test(version ?? "")) {
    throw new Error(`${name} must declare an exact TypeScript 7 version`)
  }

  // A supported platform must not silently switch compilers after a failed or
  // skipped optional install. The stable fallback is for other platforms only.
  let packageJson
  try {
    packageJson = require.resolve(`${name}/package.json`)
  } catch (cause) {
    throw new Error(`Root typecheck requires ${name}@${version}; install root dependencies`, {
      cause,
    })
  }
  const installed = JSON.parse(readFileSync(packageJson, "utf8"))
  if (installed.version !== version) {
    throw new Error(`Root typecheck requires ${name}@${version}, found ${installed.version}`)
  }
  const binary = join(
    dirname(packageJson),
    preview ? "lib" : "bin",
    preview && platform === "win32" ? "tsc.exe" : "tsc"
  )
  if (!statSync(binary, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Root typecheck compiler is missing: ${binary}`)
  }
  const executable =
    preview && platform === "win32" && binary.length >= 248 ? `\\\\?\\${binary}` : binary
  return preview ? { executable, prefix: [] } : { executable: process.execPath, prefix: [binary] }
}

export function runRootTypecheck(root, argv = process.argv.slice(2)) {
  const { executable, prefix } = resolveRootCompiler(root)
  const args = [...prefix, ...argv]
  if (process.platform !== "win32" && typeof process.execve === "function") {
    try {
      process.execve(executable, [executable, ...args], process.env)
    } catch {
      // Match the official launcher when execve is unavailable: execute the
      // same compiler with the same arguments, never a different toolchain.
    }
  }

  const child = spawn(executable, args, { stdio: "inherit", env: process.env })
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => child.kill(signal)])
  )
  for (const [signal, handler] of handlers) process.on(signal, handler)
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
  child.once("error", (error) => {
    cleanup()
    console.error(`Root typecheck failed to start: ${error.message}`)
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    cleanup()
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runRootTypecheck(resolve(dirname(fileURLToPath(import.meta.url)), "../.."))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
