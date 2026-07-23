// Real cognia-server Gateway leg (ADR-0090 Phase 4).
//
// Boots the actual `cognia-server` binary (the SAME cognia-gateway crate the
// desktop manages) with an isolated data dir:
//   1. seeds the Provider Profile Store via `profiles import` with a
//      deployment pointing at the conformance server (credential = env ref),
//   2. mints a gateway API key via `gateway key-create`,
//   3. writes gateway-config.json (enabled, ephemeral port) and `serve`s with
//      COGNIA_GATEWAY=1,
//   4. parses the bound gateway port from stdout.
//
// The sidecar leg then points ANTHROPIC_BASE_URL at the gateway, which
// serves from the profile-store projection (authority: profile-store) —
// no renderer anywhere.

import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..", "..")

export const UPSTREAM_KEY_ENV = "COGNIA_CONF_UPSTREAM_KEY"
export const UPSTREAM_KEY = "CONFTEST-SECRET-A"

export function serverBinaryPath() {
  const explicit = process.env.COGNIA_SERVER_BIN
  if (explicit) return explicit
  return path.join(REPO, "target", "debug", "cognia-server")
}

export function binaryAvailable() {
  const result = spawnSync(serverBinaryPath(), ["--help"], { encoding: "utf8" })
  return result.status === 0
}

function profilePayload(conformanceBaseUrl) {
  return {
    schemaVersion: 1,
    profileVersion: 1,
    providerProfiles: [
      {
        id: "conformance",
        displayName: "Conformance Vendor",
        deploymentRefs: ["conf-anthropic"],
      },
    ],
    deploymentProfiles: [
      {
        id: "conf-anthropic",
        providerRef: "conformance",
        endpoint: `${conformanceBaseUrl}/v1`,
        transportProfileRef: "tp-anthropic-x-api-key",
        credentialProfileRef: { kind: "env", var: UPSTREAM_KEY_ENV },
        models: [
          { id: "claude-opus-4-8" },
          { id: "claude-haiku-4-5-20251001" },
          { id: "claude-opus-4-8" },
        ],
        modelRoles: {
          primary: "claude-opus-4-8",
          fast: "claude-haiku-4-5-20251001",
          powerful: "claude-opus-4-8",
        },
        enabled: true,
      },
    ],
    transportProfiles: [
      { id: "tp-anthropic-x-api-key", protocol: "anthropic", auth: { scheme: "x-api-key" } },
    ],
    legacyAliases: {},
  }
}

const MASTER_KEY = "a".repeat(64)

function adminEnv(dataDir) {
  return {
    ...process.env,
    COGNIA_DATA_DIR: dataDir,
    COGNIA_MASTER_KEY: MASTER_KEY,
    [UPSTREAM_KEY_ENV]: UPSTREAM_KEY,
  }
}

function runAdmin(dataDir, args) {
  const result = spawnSync(serverBinaryPath(), args, {
    encoding: "utf8",
    env: adminEnv(dataDir),
    timeout: 60_000,
  })
  if (result.status !== 0) {
    throw new Error(
      `cognia-server ${args.join(" ")} failed (${result.status}):\n${result.stderr}\n${result.stdout}`
    )
  }
  return result.stdout.trim()
}

/**
 * Start the gateway leg. Returns `{ gatewayBaseUrl, gatewayKey, close }`.
 */
export async function startGatewayLeg({ conformanceBaseUrl }) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cognia-conf-gw-"))

  // 1. Seed profiles.
  const payloadPath = path.join(dataDir, "profiles.json")
  writeFileSync(payloadPath, JSON.stringify(profilePayload(conformanceBaseUrl)))
  runAdmin(dataDir, ["profiles", "import", payloadPath])

  // 2. Gateway API key (the sidecar's local ANTHROPIC_API_KEY for this leg).
  const gatewayKey = runAdmin(dataDir, ["gateway", "key-create", "--name", "conformance"])

  // 3. Enable the gateway on an ephemeral port.
  const cogniaDir = path.join(dataDir, ".cognia")
  mkdirSync(cogniaDir, { recursive: true })
  writeFileSync(
    path.join(cogniaDir, "gateway-config.json"),
    JSON.stringify({ enabled: true, port: 0 })
  )

  // 4. Serve (companion HTTPS on an ephemeral port too; no brain).
  const child = spawn(serverBinaryPath(), ["serve", "--port", "0"], {
    env: { ...adminEnv(dataDir), COGNIA_GATEWAY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d) => {
    stdout += d.toString()
  })
  child.stderr.on("data", (d) => {
    stderr += d.toString()
  })

  const gatewayPort = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(
        new Error(`gateway port not observed in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`)
      )
    }, 60_000)
    const poll = setInterval(() => {
      const match = stdout.match(/LLM gateway listening on port Some\((\d+)\)/)
      if (match) {
        clearTimeout(deadline)
        clearInterval(poll)
        resolve(Number(match[1]))
      }
      if (child.exitCode !== null) {
        clearTimeout(deadline)
        clearInterval(poll)
        reject(new Error(`cognia-server exited early (${child.exitCode}).\n${stderr}\n${stdout}`))
      }
    }, 100)
  })

  return {
    // Plain origin — ANTHROPIC_BASE_URL consumers append /v1/* themselves.
    gatewayBaseUrl: `http://127.0.0.1:${gatewayPort}`,
    gatewayKey,
    dataDir,
    get logs() {
      return { stdout, stderr }
    },
    async close() {
      child.kill("SIGINT")
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 5_000)
        child.once("exit", () => {
          clearTimeout(t)
          resolve()
        })
      })
    },
  }
}
