import { createECDH, createCipheriv, hkdfSync, randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const LEASE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

// The existing Host admission client reads this same Docker-config format.
// Helpers are deliberately excluded: no runner/desktop credential store is used.
function registryConfiguration(raw) {
  try {
    if (!raw?.trim()) return { auths: {} }
    if (Buffer.byteLength(raw) > 48 * 1024) throw new Error()
    const value = JSON.parse(raw)
    if (
      !value ||
      Object.keys(value).some((key) => key !== "auths") ||
      !value.auths ||
      Array.isArray(value.auths) ||
      typeof value.auths !== "object" ||
      Object.keys(value.auths).length > 32
    )
      throw new Error()
    const auths = Object.create(null)
    for (const [registry, entry] of Object.entries(value.auths)) {
      const key = [
        "docker.io",
        "index.docker.io",
        "registry-1.docker.io",
        "https://index.docker.io/v1/",
      ].includes(registry)
        ? "https://index.docker.io/v1/"
        : registry
      if (
        key !== "https://index.docker.io/v1/" &&
        !/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?$/.test(key)
      )
        throw new Error()
      if (
        auths[key] ||
        !entry ||
        Array.isArray(entry) ||
        typeof entry !== "object" ||
        Object.keys(entry).some(
          (name) =>
            !["username", "password", "auth", "identitytoken", "registrytoken"].includes(name)
        ) ||
        Object.values(entry).some(
          (field) => typeof field !== "string" || !field || /[\r\n\0]/.test(field)
        )
      )
        throw new Error()
      if (entry.identitytoken || entry.registrytoken) {
        if (Object.keys(entry).length !== 1) throw new Error()
        auths[key] = entry
      } else {
        let auth = entry.auth
        if (auth) {
          if (Object.keys(entry).length !== 1) throw new Error()
          const bytes = Buffer.from(auth, "base64")
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          if (
            bytes.toString("base64") !== auth ||
            !decoded.includes(":") ||
            /[\r\n\0]/.test(decoded)
          )
            throw new Error()
        } else {
          if (!entry.username || !entry.password || entry.username.includes(":")) throw new Error()
          auth = Buffer.from(`${entry.username}:${entry.password}`).toString("base64")
        }
        auths[key] = { auth }
      }
    }
    return { auths }
  } catch {
    throw new Error("Invalid runner registry credentials")
  }
}

export async function withRegistryConfiguration(raw, operation) {
  const config = registryConfiguration(raw)
  const directory = await mkdtemp(join(tmpdir(), "cognia-registry-"))
  try {
    const path = join(directory, "config.json")
    await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: "wx" })
    return await operation(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function prepareImages(
  config,
  registryPath,
  deadline,
  signal,
  execute = docker,
  report = console.log
) {
  const roles = ["Host", "Agent bundle", "Development"]
  // Settle every pull before its private config is deleted, including failures.
  const results = await Promise.allSettled(
    config.images.map(async (image, index) => {
      const start = Date.now()
      try {
        if (signal?.aborted || Date.now() >= deadline) throw new Error()
        await execute(
          ["--config", dirname(registryPath), "pull", image],
          Math.max(1, Math.min(15 * 60_000, deadline - Date.now())),
          signal
        )
      } catch {
        throw new Error(
          `${roles[index]} image pull failed or timed out; check the digest, registry access, and runner network`
        )
      }
      report(`${roles[index]} image ready (${Math.round((Date.now() - start) / 1000)} seconds)`)
    })
  )
  const failure = results.find((result) => result.status === "rejected")
  if (failure) {
    report(failure.reason.message)
    throw failure.reason
  }
}

export async function initializeHostState(config, registryPath, execute = docker) {
  const prefix = `cognia-${config.leaseId}`
  for (const suffix of ["data", "workspaces"]) {
    await execute([
      "volume",
      "create",
      "--label",
      `cognia.lease=${config.leaseId}`,
      `${prefix}-${suffix}`,
    ])
  }
  // Copy credentials into the trusted Host's data volume only. Never put them
  // in process arguments, Agent mounts, workflow inputs, or pairing artifacts.
  await execute([
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "node",
    "--mount",
    `type=volume,src=${prefix}-data,dst=/data`,
    "--mount",
    `type=volume,src=${prefix}-workspaces,dst=/workspaces`,
    "--mount",
    `type=bind,src=${registryPath},dst=/registry/config.json,readonly`,
    config.images[0],
    "-e",
    "const fs=require('node:fs');for(const p of ['/data','/workspaces'])fs.chownSync(p,10001,10001);for(const [p,data] of [['/data/master-key',require('node:crypto').randomBytes(32).toString('hex')],['/data/registry-auth.json',fs.readFileSync('/registry/config.json')]]){fs.writeFileSync(p,data,{mode:0o600,flag:'wx'});fs.chownSync(p,10001,10001)}",
  ])
}

export function readConfiguration(env) {
  const leaseId = env.COGNIA_RUNNER_LEASE_ID
  if (!LEASE.test(leaseId ?? "")) throw new Error("Invalid lease ID")
  const lifetimeMinutes = Number(env.COGNIA_RUNNER_LIFETIME_MINUTES)
  if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 10 || lifetimeMinutes > 330) {
    throw new Error("Lifetime must be between 10 and 330 minutes")
  }
  const images = [
    env.COGNIA_RUNNER_HOST_IMAGE,
    env.COGNIA_RUNNER_AGENT_BUNDLE_IMAGE,
    env.COGNIA_RUNNER_DEVELOPMENT_IMAGE,
  ]
  if (images.some((image) => !IMAGE.test(image ?? "")))
    throw new Error("All images must be digest pinned")
  const signaling = new URL(env.COGNIA_RUNNER_SIGNALING_URL)
  if (
    signaling.protocol !== "wss:" ||
    signaling.username ||
    signaling.password ||
    signaling.hash ||
    signaling.search
  ) {
    throw new Error("Signaling must use an unauthenticated wss URL")
  }
  const recipient = Buffer.from(env.COGNIA_RUNNER_RECIPIENT_PUBLIC_KEY ?? "", "base64")
  // computeSecret validates the point, not just its encoded length.
  const check = createECDH("prime256v1")
  check.generateKeys()
  if (recipient.length !== 65 || recipient[0] !== 4) throw new Error("Invalid recipient public key")
  check.computeSecret(recipient)
  const runId = Number(env.GITHUB_RUN_ID)
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("Missing GitHub run ID")
  return { leaseId, lifetimeMinutes, images, signalingUrl: signaling.href, recipient, runId }
}

export function parseInvitation(output, now = Date.now()) {
  const invitation = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^cgnp4\|[A-Za-z0-9_-]+$/.test(line))
  if (!invitation || invitation.length > 32_768)
    throw new Error("Host has no relay pairing invitation")
  const payload = JSON.parse(Buffer.from(invitation.slice(6), "base64url").toString("utf8"))
  if (
    typeof payload.host !== "string" ||
    !payload.host ||
    !payload.relay ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= now + 30_000
  ) {
    throw new Error("Host returned an expired or incomplete pairing invitation")
  }
  return { invitation, hostId: payload.host, expiresAt: payload.exp }
}

export function encryptPairing(config, payload) {
  const ephemeral = createECDH("prime256v1")
  ephemeral.generateKeys()
  const secret = ephemeral.computeSecret(config.recipient)
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.from(config.leaseId),
      Buffer.from("cognia-github-runner-pairing-v1"),
      32
    )
  )
  secret.fill(0)
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(`${config.leaseId}:${config.runId}`))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  key.fill(0)
  return {
    version: 1,
    leaseId: config.leaseId,
    runId: config.runId,
    ephemeralPublicKey: ephemeral.getPublicKey().toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
}

export function hostArguments(config, socketGid) {
  const prefix = `cognia-${config.leaseId}`
  return [
    "run",
    "--detach",
    "--name",
    prefix,
    "--label",
    `cognia.lease=${config.leaseId}`,
    "--init",
    "--group-add",
    String(socketGid),
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=volume,src=${prefix}-data,dst=/data`,
    "--mount",
    `type=volume,src=${prefix}-workspaces,dst=/workspaces`,
    "--mount",
    "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    "--env",
    `COGNIA_SIGNALING_URL=${config.signalingUrl}`,
    "--env",
    `COGNIA_PUBLIC_SIGNALING_URL=${config.signalingUrl}`,
    "--env",
    `COGNIA_DEPLOYMENT_ID=${prefix}`,
    "--env",
    "COGNIA_EXEC_BACKEND=local-process",
    "--env",
    "COGNIA_MASTER_KEY_FILE=/data/master-key",
    "--env",
    "COGNIA_REGISTRY_AUTH_FILE=/data/registry-auth.json",
    "--env",
    "COGNIA_SANDBOX_POOL_ENABLED=true",
    "--env",
    `COGNIA_RUNNER_IMAGE=${config.images[2]}`,
    "--env",
    `COGNIA_AGENT_BUNDLE_IMAGE=${config.images[1]}`,
    "--env",
    "COGNIA_WORKSPACES_DIR=/workspaces",
    "--env",
    `COGNIA_WORKSPACES_VOLUME=${prefix}-workspaces`,
    config.images[0],
    "serve",
    "--bind-loopback",
    "--allow-remote-terminal",
  ]
}

async function docker(args, timeout = 60_000, signal) {
  const env = { ...process.env }
  delete env.COGNIA_RUNNER_REGISTRY_AUTH
  try {
    return (
      await exec("docker", args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8", signal, env })
    ).stdout
  } catch {
    // docker exec pairing output can contain a credential: never print it.
    throw new Error(`Docker ${args[0]} failed or timed out`)
  }
}

export async function cleanup(leaseId, execute = docker) {
  if (!LEASE.test(leaseId ?? "")) throw new Error("Invalid lease ID")
  const prefix = `cognia-${leaseId}`
  const failed = []
  // Stop the Host first so it cannot schedule more work during cleanup.
  await execute(["rm", "--force", prefix]).catch(() => failed.push("host"))
  try {
    const ids = (
      await execute(["ps", "--all", "--quiet", "--filter", `label=cognia.deployment=${prefix}`])
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (ids.length) await execute(["rm", "--force", ...ids])
    const volumes = (
      await execute(["volume", "ls", "--quiet", "--filter", `label=cognia.deployment=${prefix}`])
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (volumes.length) await execute(["volume", "rm", "--force", ...volumes])
    await execute(["volume", "rm", "--force", `${prefix}-data`, `${prefix}-workspaces`])
  } catch {
    failed.push("owned resources")
  }
  // A repeated cleanup may find the host already absent. Owned-resource errors
  // still surface; the GitHub-hosted VM is the final lease boundary.
  if (failed.includes("owned resources")) throw new Error("Lease resource cleanup failed")
}

export async function run(env = process.env) {
  const config = readConfiguration(env)
  const started = Date.now()
  const deadline = started + config.lifetimeMinutes * 60_000
  const prefix = `cognia-${config.leaseId}`
  const artifactName = `cognia-runner-${config.leaseId}`
  const { DefaultArtifactClient } = await import("@actions/artifact")
  const artifact = new DefaultArtifactClient()
  const directory = await mkdtemp(join(tmpdir(), "cognia-pairing-"))
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  let published = false
  try {
    console.log("Preparing digest-pinned Host, Agent bundle, and development images")
    await withRegistryConfiguration(env.COGNIA_RUNNER_REGISTRY_AUTH, async (path) => {
      await prepareImages(config, path, deadline, controller.signal)
      if (!controller.signal.aborted && Date.now() < deadline) {
        console.log("Initializing private Host state")
        await initializeHostState(config, path)
      }
    })
    if (controller.signal.aborted || Date.now() >= deadline) return
    const socket = await stat("/var/run/docker.sock")
    console.log("Starting Host and waiting for relay pairing")
    await docker(hostArguments(config, socket.gid))
    let nextPairing = 0
    let readyDeadline = Date.now() + 120_000
    while (!controller.signal.aborted && Date.now() < deadline) {
      const running = await docker(["inspect", "--format", "{{.State.Running}}", prefix])
      if (running.trim() !== "true") throw new Error("Cognia Host exited")
      if (Date.now() >= nextPairing) {
        let payload
        try {
          payload = parseInvitation(
            await docker(["exec", prefix, "/usr/local/bin/cognia-server", "pair"], 15_000)
          )
        } catch (error) {
          if (Date.now() > readyDeadline) throw error
        }
        if (payload) {
          const path = join(directory, "pairing.json")
          await writeFile(path, JSON.stringify(encryptPairing(config, payload)), { mode: 0o600 })
          if (published) await artifact.deleteArtifact(artifactName)
          await artifact.uploadArtifact(artifactName, [path], directory, {
            retentionDays: 1,
            compressionLevel: 0,
          })
          published = true
          console.log(
            `Host ready; encrypted pairing refreshed (${Math.round((Date.now() - started) / 1000)} seconds since bootstrap)`
          )
          nextPairing = Math.min(payload.expiresAt - 60_000, Date.now() + 180_000)
          readyDeadline = nextPairing + 60_000
        }
      }
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer)
          controller.signal.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, 5_000)
        controller.signal.addEventListener("abort", done, { once: true })
      })
    }
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    // Dedicated GitHub-hosted VM. Release the Host before its named state volumes.
    await cleanup(config.leaseId).catch(() =>
      console.error("Lease cleanup needs the workflow finalizer")
    )
    if (published) await artifact.deleteArtifact(artifactName).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const operation =
    process.argv[2] === "--cleanup" ? cleanup(process.env.COGNIA_RUNNER_LEASE_ID) : run()
  operation.catch(() => {
    console.error("Cognia runner bootstrap failed; no credentials were logged")
    process.exitCode = 1
  })
}
