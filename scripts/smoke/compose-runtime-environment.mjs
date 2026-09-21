#!/usr/bin/env node
/**
 * End-to-end smoke for runtime environment sandboxes (ADR-0182/0183) on the
 * compose T2 stack: a Docker daemon behind the socket proxy, with the agent
 * bundle injected into images the project chose.
 *
 * What it proves, with no model credentials:
 *
 *   - node:22-alpine (musl) chosen from the tenant image catalog, and
 *     python:3.12-slim (glibc, no git) from a repository declaration approved
 *     on the Host, each resolved to a digest through the registry;
 *   - each spec admitted by the dry run, then spawned with its placement:
 *     the Host reports the sandbox it got — the digest, the tier, the libc
 *     tree it staged and the user the agent actually runs as — and the
 *     bundled codex-acp answers an ACP `initialize` from inside it;
 *   - the probe cache agrees with the placement about libc and user;
 *   - admission refuses what it must: a digest that does not match its spec,
 *     a declaration nobody approved, a revoked approval, a revoked entry.
 *
 * `--expect pool-off` runs against a stack WITHOUT the overlay instead and
 * proves Q39's off path: every environment command answers
 * `sandbox_pool_disabled`, a spawn that requires isolation is refused, and
 * one that does not runs on the existing path with a
 * `sandbox_fallback_pool_disabled` placement.
 *
 * Usage:
 *
 *   # 1. A baseline naming the agent bundle image you built (deploy/bundle).
 *   node scripts/smoke/compose-runtime-environment.mjs baseline \
 *     --bundle-image ghcr.io/<owner>/cognia-agent-bundle@sha256:<digest> \
 *     [--release-tag <tag>] --out /tmp/environment-baseline.json
 *
 *   # 2. The server tier with the pool on (from deploy/compose).
 *   COGNIA_ENVIRONMENT_BASELINE_HOST_FILE=/tmp/environment-baseline.json \
 *     docker compose -f docker-compose.yml -f docker-compose.t2.yml \
 *     -f docker-compose.runtime-environment.yml --profile server up -d --wait
 *
 *   # 3. The smoke.
 *   node scripts/smoke/compose-runtime-environment.mjs
 *
 * Env knobs: those of `compose-smoke.mjs` (COGNIA_SERVER_URL,
 * COMPOSE_FILE_PATH, COGNIA_SMOKE_EXEC). The off-path fallback spawn uses the
 * stub agent and needs COGNIA_SMOKE_AGENT=1 on the server, as tier 2 does.
 */

import process from "node:process"
import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

// Node 26 strips types, so the smoke seals specs with the very canonicalizer
// and reference parser the brain uses — pinned against the Rust side by
// `protocol/environment-spec-fixtures.json` and
// `protocol/image-reference-fixtures.json`, which this file's test replays.
import { canonicalizeJson } from "../../lib/plugin/character-pack/canonical-json.ts"
import { parseImageReference } from "../../lib/project-environment/image-reference.ts"

/** The two images the smoke runs, one per libc tree. */
export const SMOKE_IMAGES = [
  {
    key: "musl",
    reference: "docker.io/library/node:22-alpine",
    libc: "musl",
    source: "project-setting",
  },
  {
    key: "glibc",
    reference: "docker.io/library/python:3.12-slim",
    libc: "glibc",
    source: "repo-declaration",
  },
]

/** The preset form of codex-acp; inside a sandbox it maps onto the bundle. */
export const CODEX_ACP = { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] }

/** The uid a plain-container sandbox runs as when nothing declares a user. */
export const CONTAINER_TIER_UID = 10001

const TIER_ORDER = ["container", "gvisor", "vm"]

const EMPTY_RUNTIME_FIELDS = {
  containerEnv: {},
  lifecycleCommands: {},
  forwardPorts: [],
  user: {},
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

// ---------------------------------------------------------------------------
// Pure parts (covered by compose-runtime-environment.test.mjs)
// ---------------------------------------------------------------------------

/** `registry/repository@sha256:…` → its parts; a tag-only reference is refused. */
export function pinnedImage(reference) {
  const parsed = parseImageReference(reference)
  if (!parsed.digest) {
    throw new Error(`${reference} is not pinned to a digest; a baseline bundle must be`)
  }
  return { registry: parsed.registry, repository: parsed.repository, digest: parsed.digest }
}

/**
 * The environment baseline the smoke stack boots with: the pool on, single
 * tenant, the two smoke images allowlisted, one small size class and the
 * bundle under test. No catalog entries — the smoke adds its own.
 */
export function smokeBaseline({ bundleImage, releaseTag = "smoke" }) {
  const bundle = pinnedImage(bundleImage)
  const repositories = SMOKE_IMAGES.map((image) => parseImageReference(image.reference))
  return {
    version: 1,
    revision: 0,
    sandboxPool: { enabled: true },
    multiTenant: false,
    registryAllowlist: [
      ...new Map(
        repositories.map(({ registry, repository }) => {
          const prefix = repository.split("/").slice(0, -1).join("/")
          return [`${registry}/${prefix}`, { registry, repositoryPrefix: prefix }]
        })
      ).values(),
    ],
    isolationFloor: "container",
    entries: [],
    sizeClasses: [
      {
        id: "smoke",
        label: "Smoke",
        cpuMillis: 1000,
        memoryMib: 1024,
        ephemeralStorageMib: 2048,
        volumeMib: 2048,
      },
    ],
    egressPresets: [],
    internalExceptions: [],
    bundle: { current: { ...bundle, releaseTag }, retained: [] },
  }
}

/** The runtime-fields digest an approval freezes (`approval::runtime_fields_digest`). */
export function runtimeFieldsDigest(fields = EMPTY_RUNTIME_FIELDS) {
  return sha256(
    canonicalizeJson({
      containerEnv: fields.containerEnv,
      lifecycleCommands: fields.lifecycleCommands,
      forwardPorts: fields.forwardPorts,
      user: fields.user,
    })
  )
}

/** A spec body sealed with its digest, `specDigest` right after `version`. */
export function sealSpec(body) {
  const { specDigest: _stale, explain: _explain, ...content } = body
  const specDigest = sha256(canonicalizeJson(content))
  const { version, ...rest } = content
  return { version, specDigest, ...rest }
}

/**
 * The spec a run would carry for `image`, from `source`: an ephemeral,
 * networkless, container-tier sandbox on the current bundle.
 */
export function smokeSpec({ projectId, source, image, catalogEntryId, bundle, sizeClassId }) {
  return sealSpec({
    version: 1,
    projectId,
    source,
    image: {
      registry: image.registry,
      repository: image.repository,
      digest: image.digest,
      ...(catalogEntryId ? { catalogEntryId } : {}),
    },
    bundle: { digest: bundle.digest, releaseTag: bundle.releaseTag, pinned: false },
    isolation: { minimum: "container" },
    sizeClassId,
    lifecycle: "ephemeral",
    ...EMPTY_RUNTIME_FIELDS,
    egress: { tier: "off", presetIds: [], approvedDomains: [] },
    browserSidecar: false,
  })
}

/** An ACP `initialize` request as one stdio line. */
export function acpInitializeLine(id) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
  })
}

/** The JSON-RPC response to `id` in one stdout line, or `undefined`. */
export function acpResponse(line, id) {
  if (typeof line !== "string") return undefined
  try {
    const message = JSON.parse(line)
    return message && message.jsonrpc === "2.0" && message.id === id ? message : undefined
  } catch {
    return undefined
  }
}

/**
 * Why `placement` is not the sandbox the smoke asked for; empty when it is.
 * The user is checked against the tier the Host attested, since that is what
 * decides the default.
 */
export function placementProblems(placement, { spec, libc, availableTiers }) {
  const problems = []
  if (placement?.kind !== "sandbox") {
    return [`expected a sandbox placement, got ${JSON.stringify(placement)}`]
  }
  if (placement.driver !== "docker") problems.push(`driver ${placement.driver}`)
  if (placement.specDigest !== spec.specDigest) problems.push("spec digest differs")
  if (!String(placement.image ?? "").endsWith(`@${spec.image.digest}`)) {
    problems.push(`image ${placement.image} is not ${spec.image.digest}`)
  }
  const tier = placement.isolationTier
  if (!availableTiers.includes(tier) || TIER_ORDER.indexOf(tier) < 0) {
    problems.push(`tier ${tier} is not one the driver offers`)
  }
  if (placement.bundle?.digest !== spec.bundle.digest) problems.push("bundle digest differs")
  if (placement.bundle?.libc !== libc) problems.push(`libc ${placement.bundle?.libc}, want ${libc}`)
  if (placement.command !== "codex-acp") problems.push(`command ${placement.command}`)
  const uid = tier === "container" ? CONTAINER_TIER_UID : 0
  if (placement.user?.uid !== uid) problems.push(`runs as uid ${placement.user?.uid}, want ${uid}`)
  // Step ①: `off` is enforced by cutting the network, and ambient provider
  // credentials are stripped before the container starts — this spawn carries
  // no gateway task lease, so the placement must say `none`. Both are labeled
  // on the run, and both are asserted here so a change to either is a
  // deliberate one.
  if (placement.egress?.tier !== "off" || placement.egress?.enforced !== true) {
    problems.push(`egress ${JSON.stringify(placement.egress)}`)
  }
  if (placement.credentials?.mode !== "none") {
    problems.push(`credentials ${JSON.stringify(placement.credentials)}`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// Driving the stack
// ---------------------------------------------------------------------------

let failures = 0
const log = (...parts) => console.log("[runtime-env]", ...parts)
const fatal = (message) => {
  console.error("[runtime-env] FAIL:", message)
  process.exit(1)
}
function check(condition, message) {
  if (condition) {
    log("  ok:", message)
  } else {
    console.error("[runtime-env]  FAIL:", message)
    failures++
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** The canonical `/ws/events` stream, widened to `channels`. */
async function openEvents(host, device, channels) {
  const ticketPath = "/api/auth/socket-ticket"
  const response = await fetch(`${host.SERVER_URL}${ticketPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${device.accessToken}`,
      DPoP: await host.deviceProof(device.privateKey, device.accessJti, "POST", ticketPath),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: "events" }),
  })
  const { ticket } = await response.json()
  if (!response.ok || typeof ticket !== "string") fatal("no event socket ticket")

  const frames = []
  const waiters = new Set()
  const socket = new WebSocket(
    `${host.SERVER_URL.replace(/^http/, "ws")}/ws/events?ticket=${encodeURIComponent(ticket)}`
  )
  socket.addEventListener("message", (event) => {
    let frame
    try {
      frame = JSON.parse(event.data.toString())
    } catch {
      return
    }
    frames.push(frame)
    for (const waiter of [...waiters]) {
      if (waiter.match(frame)) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })

  const waitFor = (match, timeoutMs) => {
    const seen = frames.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve) => {
      const waiter = {
        match,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter)
          resolve(undefined)
        }, timeoutMs),
      }
      waiters.add(waiter)
    })
  }

  const subscribed = waitFor((frame) => frame.type === "subscribed", 10_000)
  socket.send(JSON.stringify({ type: "subscribe", mode: "add", channels }))
  const ack = await subscribed
  check(
    channels.every((channel) => ack?.channels?.includes(channel)) && !ack?.rejected?.length,
    `event socket subscribed to ${channels.join(", ")}`
  )
  return { waitFor, close: () => socket.close() }
}

async function poolOn(host) {
  await host.waitForServerHealthz()
  const device = await host.pairDevice()
  if (!device) fatal("pairing failed")
  // Catalog writes and approvals are host control, which a device must be
  // granted explicitly (ADR-0149).
  await host.composeExec(["cognia-server", "devices", "grant", device.deviceId, "--control"])
  const serviceToken = (await host.composeExec(["cognia-server", "issue-service-token"])).trim()

  const driver = await host.rpc("environment_driver_status", {}, device)
  if (driver.body?.code === "sandbox_pool_disabled") {
    fatal(
      "the sandbox pool is off on this stack; start it with docker-compose.runtime-environment.yml"
    )
  }
  check(driver.status === 200 && driver.body?.driver === "docker", "the Docker driver answers")
  check(
    driver.body?.reachable === true,
    `the daemon is reachable (${driver.body?.unreachableReason ?? "ok"})`
  )
  const availableTiers = driver.body?.availableTiers ?? []
  check(
    availableTiers.includes("container"),
    `container tier available (${availableTiers.join(", ")})`
  )

  const catalog = await host.rpc("environment_catalog_list", { pageSize: 200 }, device)
  check(
    catalog.status === 200 && catalog.body?.poolEnabled === true,
    "the catalog reports the pool on"
  )
  const bundle = catalog.body?.bundle?.current
  check(Boolean(bundle?.digest), "the baseline offers an agent bundle")
  const sizeClass = catalog.body?.sizeClasses?.find((candidate) => !candidate.gpu)
  check(Boolean(sizeClass), "the baseline offers a usable size class")
  if (!bundle || !sizeClass) fatal("the baseline cannot admit anything")

  const events = await openEvents(host, device, [
    "external-agent://placement",
    "external-agent://stdout",
    "external-agent://exit",
  ])
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const workspace = `/workspaces/smoke-runtime-environment-${runId}`
  await host.composeExec(["mkdir", "-p", workspace])
  const cleanups = []
  try {
    for (const image of SMOKE_IMAGES) {
      await sandboxedRoundTrip(host, {
        device,
        serviceToken,
        events,
        image,
        bundle,
        sizeClass,
        availableTiers,
        runId,
        workspace,
        cleanups,
      })
    }
    await refusals(host, { device, bundle, sizeClass, runId })
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch((error) => log("cleanup failed:", error?.message ?? error))
    }
    events.close()
    await host.composeExec(["rm", "-rf", workspace]).catch(() => {})
  }
}

async function sandboxedRoundTrip(host, context) {
  // The rest of `context` is for `spawnAndGreet`.
  const { device, image, bundle, sizeClass, runId } = context
  log(`${image.reference} (${image.libc}, ${image.source})`)
  const inspected = await host.rpc(
    "environment_image_inspect",
    { reference: image.reference },
    device
  )
  check(
    inspected.status === 200 && /^sha256:[0-9a-f]{64}$/.test(inspected.body?.digest ?? ""),
    `${image.reference} resolved to ${inspected.body?.digest}`
  )
  if (inspected.status !== 200) return
  const pinned = {
    registry: inspected.body.registry,
    repository: inspected.body.repository,
    digest: inspected.body.digest,
  }
  const projectId = `smoke-${image.key}-${runId}`
  let spec

  if (image.source === "project-setting") {
    const entryId = `smoke-${image.key}-${runId}`
    const users = new Set(inspected.body.platforms.map((platform) => platform.user ?? ""))
    const imageUser = users.size === 1 ? [...users][0] : ""
    const created = await host.rpc(
      "environment_catalog_create",
      {
        entry: {
          id: entryId,
          scope: "tenant",
          label: `Smoke ${image.key}`,
          image: { ...pinned, tag: parseImageReference(image.reference).tag },
          isolationFloor: "container",
          sizeClassIds: [sizeClass.id],
          ...(imageUser ? { imageUser } : {}),
          source: "manual",
          createdAt: 0,
          updatedAt: 0,
        },
      },
      device
    )
    check(created.status === 200 && created.body?.id === entryId, `catalog entry ${entryId} added`)
    let revoked = false
    context.cleanups.push(async () => {
      if (!revoked) await host.rpc("environment_catalog_delete", { id: entryId }, device)
    })
    spec = smokeSpec({
      projectId,
      source: { kind: "project-setting", catalogEntryId: entryId },
      image: pinned,
      catalogEntryId: entryId,
      bundle,
      sizeClassId: sizeClass.id,
    })
    await spawnAndGreet(host, { ...context, spec })
    // Revoking the entry withdraws it from admission at once.
    await host.rpc("environment_catalog_delete", { id: entryId }, device)
    revoked = true
    const after = await host.rpc("environment_spec_resolve_preview", { spec }, device)
    check(
      after.body?.admitted === false && after.body?.refusalCode === "catalog_entry_unavailable",
      `a revoked entry is refused (${after.body?.refusalCode})`
    )
    return
  }

  const path = ".devcontainer/devcontainer.json"
  const declarationDigest = sha256(`compose-runtime-environment ${runId} ${image.reference}`)
  const approvalId = `env-approval:smoke-${image.key}-${runId}`
  const approved = await host.rpc(
    "environment_approval_approve",
    {
      approval: {
        id: approvalId,
        projectId,
        normalizedRemote: "https://example.invalid/cognia/runtime-environment-smoke.git",
        path,
        declarationDigest,
        resolvedImage: pinned,
        runtimeFieldsDigest: runtimeFieldsDigest(),
      },
    },
    device
  )
  check(
    approved.status === 200 && approved.body?.via === "hostOwner",
    `the declaration was approved by the host owner (${approved.body?.via ?? approved.body?.code})`
  )
  let revoked = false
  context.cleanups.push(async () => {
    if (!revoked) await host.rpc("environment_approval_revoke", { id: approvalId }, device)
  })
  spec = smokeSpec({
    projectId,
    source: {
      kind: "repo-declaration",
      file: "devcontainer",
      path,
      remote: "https://example.invalid/cognia/runtime-environment-smoke",
      commitSha: sha256(runId).slice(0, 40),
      declarationDigest,
      approvalRef: approvalId,
    },
    image: pinned,
    bundle,
    sizeClassId: sizeClass.id,
  })
  await spawnAndGreet(host, { ...context, spec })
  const revoke = await host.rpc("environment_approval_revoke", { id: approvalId }, device)
  revoked = revoke.status === 200
  check(revoked && typeof revoke.body?.revokedAt === "number", "the approval was revoked")
  const after = await host.rpc("environment_spec_resolve_preview", { spec }, device)
  check(
    after.body?.admitted === false && after.body?.refusalCode === "approval_revoked",
    `a revoked approval is refused (${after.body?.refusalCode})`
  )
}

async function spawnAndGreet(
  host,
  { device, serviceToken, events, image, spec, availableTiers, runId, workspace }
) {
  const preview = await host.rpc("environment_spec_resolve_preview", { spec }, device)
  check(
    preview.body?.admitted === true && preview.body?.specDigest === spec.specDigest,
    `the dry run admits the spec (${preview.body?.refusalCode ?? preview.body?.actualTier})`
  )
  check(preview.body?.bundleDigest === spec.bundle.digest, "the dry run picked the offered bundle")

  const agentId = `smoke-env-${image.key}-${runId}`
  const placementFrame = events.waitFor(
    (frame) => frame.type === "external-agent://placement" && frame.payload?.agentId === agentId,
    300_000
  )
  const spawned = await host.containerRpc(
    "spawn_external_agent",
    {
      config: {
        id: agentId,
        ...CODEX_ACP,
        cwd: workspace,
        // Mandatory: a smoke that silently fell back would prove nothing.
        sandbox: { kind: "container", spec, isolationMandatory: true },
      },
    },
    serviceToken
  )
  check(spawned === agentId, `spawned ${agentId} (${JSON.stringify(spawned)})`)
  if (spawned !== agentId) return

  try {
    const placement = (await placementFrame)?.payload?.placement
    const problems = placementProblems(placement, { spec, libc: image.libc, availableTiers })
    check(
      problems.length === 0,
      `the Host reported the sandbox it gave (${problems.join("; ") || placement?.isolationTier})`
    )

    const reply = events.waitFor(
      (frame) =>
        frame.type === "external-agent://stdout" &&
        frame.payload?.agentId === agentId &&
        acpResponse(frame.payload?.data, 1) !== undefined,
      120_000
    )
    await host.containerRpc(
      "send_to_external_agent",
      { agent_id: agentId, message: acpInitializeLine(1) },
      serviceToken
    )
    const response = acpResponse((await reply)?.payload?.data, 1)
    check(
      typeof response?.result?.protocolVersion === "number",
      `the bundled codex-acp answered initialize (${JSON.stringify(response?.error ?? response?.result?.protocolVersion)})`
    )

    const probe = await host.rpc(
      "environment_probe_get",
      { userImageDigest: spec.image.digest, bundleDigest: spec.bundle.digest },
      device
    )
    const cached = probe.body?.cached
    check(probe.body?.unreadable === false && Boolean(cached), "the probe verdict was cached")
    check(cached?.libc === image.libc, `the probe found ${cached?.libc}`)
    check(
      cached?.problems?.length === 0,
      `the probe accepted the image (${JSON.stringify(cached?.problems)})`
    )
    check(
      cached?.resolvedUser?.uid === placement?.user?.uid,
      `the probe and the placement agree on the user (uid ${cached?.resolvedUser?.uid})`
    )
    check(cached?.runtimes?.includes("codex-acp"), "the image can run codex-acp")
  } finally {
    await host.containerRpc("kill_external_agent", { agent_id: agentId }, serviceToken)
  }
}

async function refusals(host, { device, bundle, sizeClass, runId }) {
  const image = pinnedImage(`docker.io/library/busybox@sha256:${"0".repeat(64)}`)
  const spec = smokeSpec({
    projectId: `smoke-refusals-${runId}`,
    source: {
      kind: "repo-declaration",
      file: "devcontainer",
      path: ".devcontainer/devcontainer.json",
      remote: "https://example.invalid/cognia/runtime-environment-smoke",
      commitSha: "0".repeat(40),
      declarationDigest: "1".repeat(64),
      approvalRef: `env-approval:never-${runId}`,
    },
    image,
    bundle,
    sizeClassId: sizeClass.id,
  })
  const unapproved = await host.rpc("environment_spec_resolve_preview", { spec }, device)
  check(
    unapproved.body?.refusalCode === "approval_missing",
    `an unapproved declaration is refused (${unapproved.body?.refusalCode})`
  )
  const tampered = await host.rpc(
    "environment_spec_resolve_preview",
    { spec: { ...spec, sizeClassId: `${sizeClass.id}-other` } },
    device
  )
  check(
    tampered.body?.refusalCode === "spec_digest_mismatch",
    `a spec that does not match its digest is refused (${tampered.body?.refusalCode})`
  )
}

async function poolOff(host) {
  await host.waitForServerHealthz()
  const device = await host.pairDevice()
  if (!device) fatal("pairing failed")
  for (const name of ["environment_driver_status", "environment_catalog_list"]) {
    const response = await host.rpc(name, {}, device)
    check(
      response.status === 503 && response.body?.code === "sandbox_pool_disabled",
      `${name} answers sandbox_pool_disabled (${response.status} ${response.body?.code})`
    )
  }

  const serviceToken = (await host.composeExec(["cognia-server", "issue-service-token"])).trim()
  const runId = Date.now().toString(36)
  const spec = smokeSpec({
    projectId: `smoke-off-${runId}`,
    source: { kind: "deployment-default", catalogEntryId: "legacy-env" },
    image: pinnedImage(`docker.io/library/busybox@sha256:${"0".repeat(64)}`),
    bundle: { digest: `sha256:${"0".repeat(64)}`, releaseTag: "none" },
    sizeClassId: "legacy-env",
  })
  const refused = await host.containerRpc(
    "spawn_external_agent",
    {
      // The preset command clears the spawn policy without the stub agent's
      // opt-in; the refusal comes before anything is started.
      config: {
        id: `smoke-off-mandatory-${runId}`,
        ...CODEX_ACP,
        sandbox: { kind: "container", spec, isolationMandatory: true },
      },
    },
    serviceToken
  )
  check(
    /sandbox_pool_disabled/.test(JSON.stringify(refused)),
    `a spawn that requires isolation is refused (${JSON.stringify(refused)})`
  )

  if (process.env.COGNIA_SMOKE_AGENT !== "1") {
    log("SKIP: COGNIA_SMOKE_AGENT unset — the fallback spawn needs the stub agent")
    return
  }
  const events = await openEvents(host, device, ["external-agent://placement"])
  const agentId = `smoke-off-fallback-${runId}`
  try {
    const placement = events.waitFor(
      (frame) => frame.type === "external-agent://placement" && frame.payload?.agentId === agentId,
      30_000
    )
    const spawned = await host.containerRpc(
      "spawn_external_agent",
      {
        config: {
          id: agentId,
          command: "node",
          args: ["/opt/cognia/smoke/stub-acp-agent.mjs"],
          sandbox: { kind: "container", spec, isolationMandatory: false },
        },
      },
      serviceToken
    )
    check(spawned === agentId, "a spawn that allows a fallback runs on the existing path")
    const reported = (await placement)?.payload?.placement
    check(
      reported?.kind === "fallback" && reported?.code === "sandbox_fallback_pool_disabled",
      `and says so (${JSON.stringify(reported)})`
    )
  } finally {
    await host.containerRpc("kill_external_agent", { agent_id: agentId }, serviceToken)
    events.close()
  }
}

async function main() {
  if (process.argv[2] === "baseline") {
    const bundleImage = argValue("--bundle-image")
    if (!bundleImage) fatal("baseline needs --bundle-image <image@sha256:…>")
    const text = `${JSON.stringify(
      smokeBaseline({ bundleImage, releaseTag: argValue("--release-tag") ?? "smoke" }),
      null,
      2
    )}\n`
    const out = argValue("--out")
    if (out) {
      writeFileSync(out, text)
      log(`wrote ${out}`)
    } else {
      process.stdout.write(text)
    }
    return
  }

  const expect = argValue("--expect") ?? "pool-on"
  if (!["pool-on", "pool-off"].includes(expect)) fatal(`unknown --expect ${expect}`)
  // The compose stack serves a self-signed certificate, as in compose-smoke.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
  const host = await import("./compose-smoke.mjs")
  if (expect === "pool-on") await poolOn(host)
  else await poolOff(host)

  const total = failures + host.smokeFailureCount()
  if (total > 0) fatal(`${total} check(s) failed`)
  log("OK — all checks passed")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[runtime-env] FAIL (uncaught):", error)
    process.exit(1)
  })
}
