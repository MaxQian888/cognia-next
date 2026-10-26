#!/usr/bin/env node

// No model credentials or requests: exercise the real frozen CLI and ACP
// transport in an offline container before publishing an image.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const master = JSON.parse(
  readFileSync(new URL("../bundle/npm/package.json", import.meta.url), "utf8")
)
const pins = JSON.parse(
  readFileSync(new URL("../bundle/agent-versions.json", import.meta.url), "utf8")
)

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 })
  assert.equal(
    result.status,
    0,
    `docker ${args.join(" ")}: ${result.error?.message ?? result.stderr}`
  )
  return result.stdout.trim()
}

export async function initializeAcp(
  image,
  {
    packageSpec = "@agentclientprotocol/codex-acp",
    runArgs = [],
    entrypoint = "npx",
    args = ["-y", packageSpec],
  } = {}
) {
  const name = `cognia-agent-acp-smoke-${process.pid}-${Date.now()}`
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "-i",
      ...runArgs,
      "--entrypoint",
      entrypoint,
      image,
      ...args,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  )
  let stdout = ""
  let stderr = ""
  try {
    const response = await new Promise((accept, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`ACP initialize timed out: ${stderr.slice(-2000)}`)),
        30_000
      )
      const finish = (fn, value) => {
        clearTimeout(timer)
        fn(value)
      }
      child.on("error", (error) => finish(reject, error))
      child.on("close", (code) =>
        finish(reject, new Error(`ACP exited ${code}: ${stderr.slice(-2000)}`))
      )
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-8000)
      })
      child.stdout.on("data", (chunk) => {
        stdout += chunk
        const lines = stdout.split("\n")
        stdout = lines.pop()
        for (const line of lines) {
          let message
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.id === 1) finish(accept, message)
        }
      })
      child.stdin.on("error", (error) => finish(reject, error))
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "cognia-image-smoke", version: "1.0.0" } } })}\n`
      )
    })
    assert.equal(response.error, undefined, JSON.stringify(response))
    assert.equal(response.result?.protocolVersion, 1, JSON.stringify(response))
    return response.result
  } finally {
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8", timeout: 15_000 })
    child.kill("SIGTERM")
  }
}

export async function smokeRunner(image, variant) {
  assert.ok(["full", "codex"].includes(variant), "variant must be full or codex")
  const version = docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "codex",
    image,
    "--version",
  ])
  assert.ok(version.includes(master.dependencies["@openai/codex"]), version)
  const initialized = await initializeAcp(image)
  await initializeAcp(image, { packageSpec: "@zed-industries/codex-acp" })
  if (variant === "codex") {
    const absent = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "npx",
        image,
        "-y",
        "@google/gemini-cli",
      ],
      { encoding: "utf8", timeout: 15_000 }
    )
    assert.equal(absent.status, 1, absent.stderr)
    assert.match(absent.stderr, /Agent .*not installed.*AGENT_RUNTIMES/s)
    for (const [args, reason] of [
      [["--yes=true", "@google/gemini-cli"], /not installed/],
      [["--yes=true", "@openai/codex@latest"], /frozen/],
      [["@openai/codex@"], /frozen/],
      [["@google/gemini-cli@"], /not installed/],
      [["--no-offline=true", "missing-project-tool"], /offline/],
    ]) {
      const rejected = spawnSync(
        "docker",
        ["run", "--rm", "--network", "none", "--entrypoint", "npx", image, ...args],
        { encoding: "utf8", timeout: 15_000 }
      )
      assert.equal(rejected.status, 1, rejected.stderr)
      assert.match(rejected.stderr, reason)
    }
    assert.ok(
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "npx",
        image,
        "--yes=true",
        "codex",
        "--version",
      ]).includes(master.dependencies["@openai/codex"])
    )
    assert.equal(
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "sh",
        image,
        "-c",
        'for cli in claude gemini copilot qwen pi opencode; do if command -v "$cli" >/dev/null; then exit 1; fi; done; echo excluded',
      ]),
      "excluded"
    )
    const dependencies = JSON.parse(
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "cat",
        image,
        "/cognia/glibc/lib/agents/package.json",
      ])
    )
    assert.deepEqual(Object.keys(dependencies.dependencies).sort(), [
      "@agentclientprotocol/codex-acp",
      "@openai/codex",
    ])
  } else {
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      image,
      "-c",
      'for cli in claude claude-agent-acp codex codex-acp gemini copilot qwen pi pi-acp opencode cline; do command -v "$cli" >/dev/null || exit 1; done',
    ])
    const checked = new Set(["codex"])
    for (const runtime of pins.runtimes) {
      for (const command of runtime.commands ?? []) {
        if (command.smoke !== "version" || checked.has(command.name)) continue
        checked.add(command.name)
        const output = docker([
          "run",
          "--rm",
          "--network",
          "none",
          "--entrypoint",
          command.name,
          image,
          "--version",
        ])
        assert.ok(
          output.includes(master.dependencies[command.package]),
          `${command.name}: ${output}`
        )
      }
    }
    docker(["run", "--rm", "--network", "none", "--entrypoint", "cline", image, "--version"])
    for (const id of ["kiro-cli", "droid"]) {
      const runtime = pins.runtimes.find((entry) => entry.id === id)
      const output = docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        id,
        image,
        "--version",
      ])
      assert.ok(output.includes(runtime.version), `${id}: ${output}`)
    }
  }
  console.log(
    JSON.stringify({ image, variant, version, acp: initialized.agentInfo, offline: true })
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeRunner(process.argv[2], process.argv[3] ?? "codex").catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
