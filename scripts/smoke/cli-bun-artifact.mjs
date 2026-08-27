import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { cliLayoutName, cliTarget, hostTargetName } from "../build/cli-bun-contract.mjs"

function parseJsonLine(output, label) {
  try {
    return JSON.parse(output.trim().split("\n").at(-1))
  } catch (error) {
    throw new Error(`${label} did not emit a JSON envelope: ${output}`, { cause: error })
  }
}

export function smokeCliArtifact(
  root,
  targetName,
  { variant = "full", externalClaudeExecutable, spawnSyncImpl = spawnSync } = {}
) {
  const target = cliTarget(targetName)
  const executable = path.join(
    root,
    "cli/dist/bin",
    cliLayoutName(target, variant),
    target.executable
  )
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`missing Bun CLI artifact: ${path.relative(root, executable)}`)
  }

  const run = (label, args, options = {}, expectedStatus = 0) => {
    const { unsetEnv = [], ...spawnOptions } = options
    const env = { ...process.env, ...spawnOptions.env }
    for (const name of unsetEnv) delete env[name]
    const result = spawnSyncImpl(executable, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      ...spawnOptions,
      env,
    })
    if (result.status !== expectedStatus) {
      throw new Error(
        `${label} failed (${result.status ?? result.signal ?? "unknown"})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
      )
    }
    return result
  }

  const version = run("CLI version smoke", ["--version"]).stdout ?? ""
  if (!version.trim()) throw new Error("CLI version smoke emitted no version")

  let claudeVersion = ""
  if (variant === "full") {
    const claudeTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-claude-probe-"))
    try {
      claudeVersion =
        run("adjacent Claude probe", [], {
          env: { COGNIA_ROLE: "claude-probe", CLAUDE_CODE_TMPDIR: claudeTmpdir },
          unsetEnv: ["COGNIA_CLAUDE_EXECUTABLE"],
        }).stdout ?? ""
      const extracted = fs.readdirSync(claudeTmpdir)
      if (extracted.length > 0) {
        throw new Error(`adjacent Claude probe extracted a duplicate: ${extracted.join(", ")}`)
      }
    } finally {
      fs.rmSync(claudeTmpdir, { recursive: true, force: true })
    }
  } else {
    if (!externalClaudeExecutable) {
      throw new Error("slim smoke requires an external Claude executable")
    }
    claudeVersion =
      run("external Claude probe", [], {
        env: {
          COGNIA_ROLE: "claude-probe",
          COGNIA_CLAUDE_EXECUTABLE: externalClaudeExecutable,
        },
      }).stdout ?? ""
    const missing = run(
      "missing external Claude probe",
      [],
      {
        env: { COGNIA_ROLE: "claude-probe", PATH: "" },
        unsetEnv: ["COGNIA_CLAUDE_EXECUTABLE"],
      },
      1
    )
    if (!/COGNIA_CLAUDE_EXECUTABLE/.test(missing.stderr ?? "")) {
      throw new Error(`missing external Claude probe was not actionable: ${missing.stderr ?? ""}`)
    }
  }
  if (!claudeVersion.trim()) throw new Error("Claude probe emitted no version")

  const codegraph = parseJsonLine(
    run("embedded codegraph probe", [], {
      env: { COGNIA_ROLE: "codegraph-probe" },
    }).stdout ?? "",
    "embedded codegraph probe"
  )
  if (codegraph.ok !== true) {
    throw new Error(`embedded codegraph probe failed: ${JSON.stringify(codegraph)}`)
  }

  const ready = parseJsonLine(
    run("embedded sidecar role", [], {
      env: { COGNIA_ROLE: "sidecar" },
      input: "",
    }).stdout ?? "",
    "embedded sidecar role"
  )
  if (ready.type !== "ready") {
    throw new Error(`embedded sidecar role did not become ready: ${JSON.stringify(ready)}`)
  }

  const webclone = parseJsonLine(
    run(
      "embedded WebClone role",
      ["-"],
      {
        env: { COGNIA_ROLE: "webclone" },
        input: "{}",
      },
      1
    ).stdout ?? "",
    "embedded WebClone role"
  )
  if (webclone.ok !== false || !/Invalid job\.mode/.test(webclone.error?.message ?? "")) {
    throw new Error(`embedded WebClone role emitted an invalid error: ${JSON.stringify(webclone)}`)
  }

  const toolBridge = run(
    "embedded tool-bridge role",
    [],
    { env: { COGNIA_ROLE: "tool-bridge" }, input: "" },
    1
  )
  if (!/missing COGNIA_TOOLHOST_SOCKET/.test(toolBridge.stderr ?? "")) {
    throw new Error(
      `embedded tool-bridge role emitted an invalid error: ${toolBridge.stderr ?? ""}`
    )
  }

  const relay = run(
    "embedded mcp-relay role",
    [],
    {
      env: {
        COGNIA_ROLE: "mcp-relay",
        COGNIA_MCP_RELAY_CONFIG: "invalid",
      },
      input: "",
    },
    1
  )
  if (!/invalid MCP relay configuration/.test(relay.stderr ?? "")) {
    throw new Error(`embedded mcp-relay role emitted an invalid error: ${relay.stderr ?? ""}`)
  }

  return executable
}

/** Exercise the packaged run-code child over its real fd-3 IPC protocol. */
export function smokeRunCodeRole(executable, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, [], {
      env: { ...process.env, COGNIA_ROLE: "run-code", COGNIA_CODE_SANDBOX_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    let stderr = ""
    child.stderr?.setEncoding?.("utf8")
    child.stderr?.on?.("data", (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => finish(new Error("embedded run-code role timed out")), 30_000)

    const finish = (error) => {
      clearTimeout(timer)
      child.kill?.("SIGKILL")
      if (error) reject(error)
      else resolve()
    }

    child.once("error", finish)
    child.once("exit", (code, signal) => {
      finish(
        new Error(
          `embedded run-code role exited before completing (${code ?? signal ?? "unknown"}): ${stderr}`
        )
      )
    })
    child.on("message", (message) => {
      if (message?.kind === "ready") {
        child.send({ kind: "start", source: "return 6 * 7", toolNames: [] })
        return
      }
      if (message?.kind === "done" && message.result === 42) {
        finish()
        return
      }
      if (message?.kind === "failed") {
        finish(new Error(`embedded run-code role failed: ${JSON.stringify(message.error)}`))
      }
    })
  })
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "../..")
  const args = process.argv.slice(2)
  const targetName =
    args.find((arg) => !arg.startsWith("--")) ?? hostTargetName(process.platform, process.arch)
  const variantArg = args.find((arg) => arg.startsWith("--variant="))
  const requestedVariant = variantArg?.slice("--variant=".length) ?? "full"
  const variants = requestedVariant === "all" ? ["full", "slim"] : [requestedVariant]
  const target = cliTarget(targetName)
  for (const variant of variants) {
    const externalClaudeExecutable =
      variant === "slim"
        ? path.join(root, "cli/dist/bin", cliLayoutName(target, "full"), target.claudeBinary)
        : undefined
    const executable = smokeCliArtifact(root, targetName, {
      variant,
      externalClaudeExecutable,
    })
    await smokeRunCodeRole(executable)
    process.stdout.write(
      `Bun CLI ${targetName}/${variant} artifact smoke passed: ${path.relative(root, executable)}\n`
    )
  }
}
