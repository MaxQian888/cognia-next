#!/usr/bin/env node
// The offline signer for the update catalog (ADR-0224 A10).
//
// The update Worker signs nothing (cognia-services/services/update-server/worker/README.md): it
// stores bundles this tool signs on a machine that holds the role keys, and
// every client verifies them against a root it shipped with
// (`lib/updates/catalog-verify.ts`, `crates/cognia-update-catalog`). So the
// keys never touch CI or the Worker, and a compromised Worker can only
// withhold a release, never forge one.
//
//   keygen        one ed25519 key per role (root, targets, snapshot, timestamp)
//   root          sign a root payload naming those keys; prints the trust-root env value
//   host-entries  the catalog entries for one host release (archive or image)
//   sign          sign a channel's targets, snapshot and timestamp over the entries
//   verify        check a bundle against a root, the way a client does
//   publish       upload a signed bundle to the Worker's admin API
//   stage-host    stage the host release in the Worker's rollout table
//   fixture       rebuild the cross-language conformance fixture
//
// Artifacts are not signed separately. A host release's archive sha256 or
// image digest sits inside the signed targets document, so it is exactly as
// trusted as the catalog (TUF's model), and there is no second key to lose.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, "../..")

export const ROLES = Object.freeze(["root", "targets", "snapshot", "timestamp"])
export const CHANNELS = Object.freeze(["stable", "beta", "canary"])
export const FIXTURE_PATH = join(projectRoot, "test-fixtures", "updates", "host-catalog.json")

/** The asset a host release is published under. */
export const HOST_ASSET_ID = "host"

/**
 * Platforms a host release ships for: the macOS and glibc Linux archives
 * (`scripts/build/package-host-archive.mjs`, the targets
 * `cognia-host-installer` resolves a machine to) and the Compose image by
 * variant and architecture (`Dockerfile.cognia-server`'s `runtime-slim` and
 * `runtime-full`, built for amd64 by `.github/workflows/images.yml`). A
 * Compose host stays on the variant it runs.
 */
export const HOST_TARGETS = Object.freeze({
  "darwin-arm64": "archive",
  "darwin-x64": "archive",
  "linux-x64": "archive",
  "linux-arm64": "archive",
  "oci-slim-amd64": "image",
  "oci-full-amd64": "image",
})

const SHA256_HEX = /^[0-9a-f]{64}$/
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/

// ── Canonical form and keys ────────────────────────────────────────────────

/**
 * The byte form a signature covers. Must match `canonicalize` in
 * `lib/updates/catalog-verify.ts` and RFC 8785 in `crates/cognia-canonical-json`:
 * keys sorted by UTF-16 code unit, undefined dropped, JSON.stringify scalars.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
  return `{${entries.join(",")}}`
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")

/** An ed25519 key from its 32-byte seed. */
export function keyFromSeed(seedHex) {
  if (!SHA256_HEX.test(seedHex)) throw new Error("an ed25519 seed is 32 bytes of lowercase hex")
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, "hex")]),
    format: "der",
    type: "pkcs8",
  })
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex")
  return { seed: seedHex, publicKey, keyid: keyIdFor(publicKey), privateKey }
}

/** A key's id: the sha256 of its raw public key. */
export function keyIdFor(publicKeyHex) {
  return createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex")
}

export function generateSeed() {
  const { privateKey } = generateKeyPairSync("ed25519")
  return privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex")
}

export function signPayload(key, payload) {
  return {
    keyid: key.keyid,
    sig: sign(null, Buffer.from(canonicalize(payload)), key.privateKey).toString("hex"),
  }
}

function readKey(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  const key = keyFromSeed(parsed.seed)
  if (parsed.publicKey && parsed.publicKey !== key.publicKey) {
    throw new Error(`${path}: the public key does not match the seed`)
  }
  return key
}

export function readRoleKeys(dir) {
  return Object.fromEntries(ROLES.map((role) => [role, readKey(join(dir, `${role}.key.json`))]))
}

/** Write one fresh key per role; refuses to overwrite a key that exists. */
export function keygen(dir, seeds = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const written = {}
  for (const role of ROLES) {
    const path = join(dir, `${role}.key.json`)
    if (existsSync(path)) throw new Error(`${path} exists; keys are never overwritten`)
    const key = keyFromSeed(seeds[role] ?? generateSeed())
    writeFileSync(
      path,
      `${JSON.stringify({ role, keyid: key.keyid, publicKey: key.publicKey, seed: key.seed }, null, 2)}\n`,
      { mode: 0o600 }
    )
    chmodSync(path, 0o600)
    written[role] = key
  }
  return written
}

// ── Root ───────────────────────────────────────────────────────────────────

/**
 * A signed root naming one key per role. `previousRootKeys` co-sign a
 * rotated root: a client accepts a new root only when the root it already
 * trusts signed it.
 */
export function buildRoot(keys, { version, expires, revokedKeyIds, previousRootKeys = [] }) {
  if (!Number.isInteger(version) || version < 1) throw new Error("root version must be >= 1")
  assertExpiry(expires)
  const payload = {
    _type: "root",
    version,
    expires,
    keys: Object.fromEntries(
      ROLES.map((role) => [
        keys[role].keyid,
        { keyid: keys[role].keyid, keytype: "ed25519", publicKey: keys[role].publicKey },
      ])
    ),
    roles: Object.fromEntries(
      ROLES.map((role) => [role, { keyids: [keys[role].keyid], threshold: 1 }])
    ),
    ...(revokedKeyIds?.length ? { revokedKeyIds } : {}),
  }
  const signers = [keys.root, ...previousRootKeys.filter((key) => key.keyid !== keys.root.keyid)]
  return { signed: payload, signatures: signers.map((key) => signPayload(key, payload)) }
}

/** The value of `NEXT_PUBLIC_UPDATE_TRUST_ROOT` and `COGNIA_UPDATE_TRUST_ROOT`. */
export function trustRootEnvValue(root) {
  return Buffer.from(JSON.stringify(root.signed)).toString("base64")
}

// ── Host entries ───────────────────────────────────────────────────────────

/** The contract this tree's brain and server are built against. */
export function repoContractIdentity() {
  const source = readFileSync(
    join(projectRoot, "cli", "src", "serve", "headless-contract-identity.ts"),
    "utf8"
  )
  const version = /HEADLESS_CONTRACT_VERSION = (\d+)/.exec(source)?.[1]
  const hash = /HEADLESS_CATALOG_HASH = "([0-9a-f]{64})"/.exec(source)?.[1]
  if (!version || !hash) throw new Error("headless-contract-identity.ts has no contract identity")
  return { contractVersion: Number(version), catalogHash: hash }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/**
 * The two entries one host release is published as, for one platform: the
 * `host-server` entry carries the artifact, the `host-brain` entry the
 * brain's identity. Both name the contract, so a release whose server and
 * brain disagree is refused before it is signed and again on the host.
 */
export function hostEntries({
  version,
  channel,
  target,
  releasedAt,
  criticality = "routine",
  releaseNotes,
  contractVersion,
  catalogHash,
  archive,
  image,
}) {
  const form = HOST_TARGETS[target]
  if (!form)
    throw new Error(
      `unknown host target ${target}; expected ${Object.keys(HOST_TARGETS).join(", ")}`
    )
  const common = {
    assetId: HOST_ASSET_ID,
    executor: "cognia-host",
    version,
    channel,
    criticality,
    releasedAt,
    target,
    contractVersion,
    catalogHash,
    ...(releaseNotes ? { releaseNotes } : {}),
  }
  let artifact
  if (form === "archive") {
    if (!archive?.url || !archive.sha256)
      throw new Error(`${target} needs an archive url and sha256`)
    artifact = { url: archive.url, sha256: archive.sha256, sizeBytes: archive.sizeBytes }
  } else {
    if (!image?.repository || !image.digest)
      throw new Error(`${target} needs an image repository and digest`)
    artifact = { image: image.repository, digest: image.digest }
  }
  const entries = [
    { ...common, kind: "host-server", ...artifact },
    { ...common, kind: "host-brain" },
  ]
  validateEntries(entries)
  return entries
}

/** Every problem with a set of entries; empty when it may be signed. */
export function entryProblems(entries) {
  const problems = []
  if (!Array.isArray(entries)) return ["entries must be an array"]
  const hostEntries = entries.filter((e) => e?.kind === "host-server" || e?.kind === "host-brain")
  const unit = (e) => `${e.channel}/${e.version}/${e.target}`
  const servers = new Map()
  const brains = new Map()
  for (const entry of hostEntries) {
    const where = `${entry.kind} ${unit(entry)}`
    if (entry.assetId !== HOST_ASSET_ID)
      problems.push(`${where}: assetId must be "${HOST_ASSET_ID}"`)
    if (entry.executor !== "cognia-host") problems.push(`${where}: executor must be "cognia-host"`)
    if (!CHANNELS.includes(entry.channel)) problems.push(`${where}: unknown channel`)
    if (!HOST_TARGETS[entry.target]) problems.push(`${where}: unknown target`)
    if (!Number.isInteger(entry.contractVersion) || entry.contractVersion < 1) {
      problems.push(`${where}: contractVersion must be a positive integer`)
    }
    if (!SHA256_HEX.test(entry.catalogHash ?? ""))
      problems.push(`${where}: catalogHash must be sha256 hex`)
    const map = entry.kind === "host-server" ? servers : brains
    if (map.has(unit(entry))) problems.push(`${where}: listed twice`)
    map.set(unit(entry), entry)
    if (entry.kind !== "host-server" || entry.revoked) continue
    if (HOST_TARGETS[entry.target] === "archive") {
      if (typeof entry.url !== "string" || !entry.url.startsWith("https://")) {
        problems.push(`${where}: an archive needs an https url`)
      }
      if (!SHA256_HEX.test(entry.sha256 ?? ""))
        problems.push(`${where}: an archive needs its sha256`)
    } else if (HOST_TARGETS[entry.target] === "image") {
      const lastSegment = typeof entry.image === "string" ? entry.image.split("/").pop() : ""
      if (!lastSegment || entry.image.includes("@") || lastSegment.includes(":")) {
        problems.push(`${where}: an image needs its repository, without a tag or digest`)
      }
      if (!OCI_DIGEST.test(entry.digest ?? ""))
        problems.push(`${where}: an image needs its sha256: digest`)
    }
  }
  for (const [key, server] of servers) {
    const brain = brains.get(key)
    if (!brain) {
      problems.push(`host-server ${key}: no host-brain entry of the same version`)
      continue
    }
    if (
      brain.contractVersion !== server.contractVersion ||
      brain.catalogHash !== server.catalogHash
    ) {
      problems.push(`host ${key}: the server and brain name different contracts`)
    }
    if (Boolean(brain.revoked) !== Boolean(server.revoked)) {
      problems.push(`host ${key}: revoke the server and brain together`)
    }
  }
  for (const key of brains.keys()) {
    if (!servers.has(key))
      problems.push(`host-brain ${key}: no host-server entry of the same version`)
  }
  return problems
}

export function validateEntries(entries) {
  const problems = entryProblems(entries)
  if (problems.length) throw new Error(`refusing to sign:\n  ${problems.join("\n  ")}`)
}

// ── Signing and verification ───────────────────────────────────────────────

function assertExpiry(expires) {
  if (Number.isNaN(Date.parse(expires))) throw new Error(`unparseable expiry ${expires}`)
}

function addDays(now, days) {
  return new Date(now + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * Sign one channel's catalog. Every role version is one past the previous
 * bundle's, because a client refuses any version below one it has seen.
 */
export function signCatalog({
  keys,
  root,
  entries,
  previous,
  now = Date.now(),
  expiresDays = { targets: 90, snapshot: 30, timestamp: 7 },
}) {
  validateEntries(entries)
  const next = (role) => (previous?.[role]?.signed?.version ?? 0) + 1
  const targets = {
    _type: "targets",
    version: next("targets"),
    expires: addDays(now, expiresDays.targets),
    entries,
  }
  const snapshot = {
    _type: "snapshot",
    version: next("snapshot"),
    expires: addDays(now, expiresDays.snapshot),
    targetsVersion: targets.version,
  }
  const timestamp = {
    _type: "timestamp",
    version: next("timestamp"),
    expires: addDays(now, expiresDays.timestamp),
    snapshotVersion: snapshot.version,
  }
  const bundle = {
    root,
    timestamp: { signed: timestamp, signatures: [signPayload(keys.timestamp, timestamp)] },
    snapshot: { signed: snapshot, signatures: [signPayload(keys.snapshot, snapshot)] },
    targets: { signed: targets, signatures: [signPayload(keys.targets, targets)] },
  }
  verifyCatalog(bundle, root.signed, now)
  return bundle
}

function verifyRole(role, doc, root, now) {
  const payload = doc?.signed
  if (payload?._type !== role) throw new Error(`${role}: wrong or missing _type`)
  if (!(Date.parse(payload.expires) > now)) throw new Error(`${role}: expired`)
  const spec = root.roles?.[role]
  const revoked = new Set(root.revokedKeyIds ?? [])
  const message = Buffer.from(canonicalize(payload))
  const counted = new Set()
  for (const signature of doc.signatures ?? []) {
    if (revoked.has(signature.keyid))
      throw new Error(`${role}: signed by revoked key ${signature.keyid}`)
    if (!spec?.keyids.includes(signature.keyid) || counted.has(signature.keyid)) continue
    const key = root.keys[signature.keyid]
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(key.publicKey, "hex"),
      ]),
      format: "der",
      type: "spki",
    })
    if (verify(null, message, publicKey, Buffer.from(signature.sig, "hex")))
      counted.add(signature.keyid)
  }
  if (!spec || counted.size < spec.threshold)
    throw new Error(`${role}: ${counted.size} valid signatures`)
}

/** The client's checks, so a bad bundle never leaves this machine. */
export function verifyCatalog(bundle, trustedRoot, now = Date.now()) {
  verifyRole("root", bundle.root, trustedRoot, now)
  const root = bundle.root.signed
  for (const role of ["timestamp", "snapshot", "targets"]) verifyRole(role, bundle[role], root, now)
  if (bundle.timestamp.signed.snapshotVersion !== bundle.snapshot.signed.version) {
    throw new Error("timestamp points at a different snapshot")
  }
  if (bundle.snapshot.signed.targetsVersion !== bundle.targets.signed.version) {
    throw new Error("snapshot pins a different targets version")
  }
  validateEntries(bundle.targets.signed.entries)
  return bundle.targets.signed
}

// ── Worker admin API ───────────────────────────────────────────────────────

async function adminPost(url, token, path, body) {
  const response = await fetch(new URL(path, url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`)
  return JSON.parse(text)
}

/** The Worker rows a host release is staged as: one per platform, server only. */
export function hostStageBodies(entries) {
  return entries
    .filter((entry) => entry.kind === "host-server" && !entry.revoked)
    .map((entry) => {
      // The Worker keys a row on target and arch: split at the last hyphen.
      const cut = entry.target.lastIndexOf("-")
      const [target, arch] = [entry.target.slice(0, cut), entry.target.slice(cut + 1)]
      return {
        assetId: entry.assetId,
        kind: entry.kind,
        channel: entry.channel,
        version: entry.version,
        target,
        arch,
        criticality: entry.criticality,
        notes: entry.releaseNotes,
        pubDate: entry.releasedAt,
        url: entry.url ?? entry.image,
        digest: entry.sha256 ?? entry.digest,
      }
    })
}

// ── Conformance fixture ────────────────────────────────────────────────────

/** Fixed seeds and clock: ed25519 is deterministic, so the fixture is too. */
export const FIXTURE_SEEDS = Object.freeze({
  root: "1".repeat(64),
  targets: "2".repeat(64),
  snapshot: "3".repeat(64),
  timestamp: "4".repeat(64),
})
export const FIXTURE_NOW = Date.parse("2026-10-12T00:00:00Z")

export function buildFixture() {
  const keys = Object.fromEntries(ROLES.map((role) => [role, keyFromSeed(FIXTURE_SEEDS[role])]))
  const root = buildRoot(keys, { version: 1, expires: "2036-10-12T00:00:00Z" })
  const identity = { contractVersion: 3, catalogHash: "c".repeat(64) }
  const release = (version, channel, extra = {}) => [
    ...hostEntries({
      version,
      channel,
      target: "darwin-arm64",
      releasedAt: "2026-10-11T00:00:00Z",
      ...identity,
      archive: {
        url: `https://github.com/maxqian888/cognia/releases/download/v${version}/cognia-host-${version}-darwin-arm64.tar.gz`,
        sha256: createHash("sha256").update(`archive ${version}`).digest("hex"),
        sizeBytes: 104_857_600,
      },
      ...extra,
    }),
    ...hostEntries({
      version,
      channel,
      target: "oci-full-amd64",
      releasedAt: "2026-10-11T00:00:00Z",
      ...identity,
      image: {
        repository: "ghcr.io/maxqian888/cognia-server",
        digest: `sha256:${createHash("sha256").update(`image ${version}`).digest("hex")}`,
      },
      ...extra,
    }),
  ]
  const entries = [...release("1.4.0", "stable"), ...release("1.5.0-beta.1", "beta")]
  const bundle = signCatalog({
    keys,
    root,
    entries,
    now: FIXTURE_NOW,
    expiresDays: { targets: 3650, snapshot: 3650, timestamp: 3650 },
  })
  return {
    description:
      "Generated by `node scripts/release/update-catalog.mjs fixture`. Verified by lib/updates/catalog-verify.test.ts and crates/cognia-update-catalog; do not edit by hand.",
    now: new Date(FIXTURE_NOW).toISOString(),
    trustRoot: root.signed,
    bundle,
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { _: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith("--")) {
      options._.push(arg)
      continue
    }
    const name = arg.slice(2)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`)
    index += 1
    if (name === "also-sign") (options[name] ??= []).push(value)
    else options[name] = value
  }
  return { command, options }
}

function need(options, name) {
  const value = options[name]
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const USAGE = `usage: update-catalog.mjs <command> [options]
  keygen --keys <dir>
  root --keys <dir> --version <n> --expires <iso> --out <root.json> [--also-sign <old-root.key.json>]
  host-entries --version <v> --channel <c> --target <t> --out <entries.json>
               (--archive <tar.gz> --url <https url> | --image <repo> --digest sha256:…)
               [--criticality routine|recommended|critical] [--notes <text>] [--released-at <iso>]
               [--contract-version <n> --catalog-hash <hex>]   (default: this tree's contract)
  sign --keys <dir> --root <root.json> --entries <entries.json> --out <bundle.json> [--previous <bundle.json>]
  verify --bundle <bundle.json> --root <trusted-root.json>
  publish --bundle <bundle.json> --channel <c> --url <worker> (token in UPDATE_ADMIN_SECRET)
  stage-host --entries <entries.json> --url <worker> (token in UPDATE_ADMIN_SECRET)
  fixture`

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv)
  switch (command) {
    case "keygen": {
      const keys = keygen(need(options, "keys"))
      for (const role of ROLES) console.log(`${role}: ${keys[role].keyid}`)
      console.log("Keep this directory offline. Back it up: a lost root key cannot be replaced.")
      return
    }
    case "root": {
      const root = buildRoot(readRoleKeys(need(options, "keys")), {
        version: Number(need(options, "version")),
        expires: need(options, "expires"),
        previousRootKeys: (options["also-sign"] ?? []).map(readKey),
      })
      writeJson(need(options, "out"), root)
      console.log(
        `NEXT_PUBLIC_UPDATE_TRUST_ROOT / COGNIA_UPDATE_TRUST_ROOT=${trustRootEnvValue(root)}`
      )
      return
    }
    case "host-entries": {
      const identity =
        options["contract-version"] !== undefined
          ? {
              contractVersion: Number(options["contract-version"]),
              catalogHash: need(options, "catalog-hash"),
            }
          : repoContractIdentity()
      const archivePath = options.archive
      const entries = hostEntries({
        version: need(options, "version"),
        channel: need(options, "channel"),
        target: need(options, "target"),
        releasedAt: options["released-at"] ?? new Date().toISOString(),
        criticality: options.criticality,
        releaseNotes: options.notes,
        ...identity,
        archive: archivePath
          ? {
              url: need(options, "url"),
              sha256: sha256File(archivePath),
              sizeBytes: statSync(archivePath).size,
            }
          : undefined,
        image: options.image
          ? { repository: options.image, digest: need(options, "digest") }
          : undefined,
      })
      const out = need(options, "out")
      const existing = existsSync(out) ? readJson(out) : []
      const merged = [...existing, ...entries]
      validateEntries(merged)
      writeJson(out, merged)
      console.log(`${out}: ${merged.length} entries`)
      return
    }
    case "sign": {
      const bundle = signCatalog({
        keys: readRoleKeys(need(options, "keys")),
        root: readJson(need(options, "root")),
        entries: readJson(need(options, "entries")),
        previous: options.previous ? readJson(options.previous) : undefined,
      })
      writeJson(need(options, "out"), bundle)
      console.log(`signed targets v${bundle.targets.signed.version}`)
      return
    }
    case "verify": {
      const root = readJson(need(options, "root"))
      const targets = verifyCatalog(readJson(need(options, "bundle")), root.signed ?? root)
      console.log(`verified: targets v${targets.version}, ${targets.entries.length} entries`)
      return
    }
    case "publish": {
      const bundle = readJson(need(options, "bundle"))
      verifyCatalog(bundle, bundle.root.signed)
      const result = await adminPost(
        need(options, "url"),
        process.env.UPDATE_ADMIN_SECRET ?? "",
        "/v1/admin/catalog",
        {
          channel: need(options, "channel"),
          bundle,
        }
      )
      console.log(JSON.stringify(result))
      return
    }
    case "stage-host": {
      const entries = readJson(need(options, "entries"))
      validateEntries(entries)
      for (const body of hostStageBodies(entries)) {
        const result = await adminPost(
          need(options, "url"),
          process.env.UPDATE_ADMIN_SECRET ?? "",
          "/v1/admin/releases",
          body
        )
        console.log(JSON.stringify(result))
      }
      return
    }
    case "fixture": {
      writeJson(FIXTURE_PATH, buildFixture())
      console.log(FIXTURE_PATH)
      return
    }
    default:
      throw new Error(USAGE)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
