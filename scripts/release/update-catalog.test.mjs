import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  FIXTURE_NOW,
  FIXTURE_PATH,
  FIXTURE_SEEDS,
  ROLES,
  buildFixture,
  buildRoot,
  canonicalize,
  entryProblems,
  hostEntries,
  hostStageBodies,
  keyFromSeed,
  keygen,
  main,
  parseArgs,
  readRoleKeys,
  repoContractIdentity,
  signCatalog,
  trustRootEnvValue,
  verifyCatalog,
} from "./update-catalog.mjs"

const keys = Object.fromEntries(ROLES.map((role) => [role, keyFromSeed(FIXTURE_SEEDS[role])]))
const root = buildRoot(keys, { version: 1, expires: "2036-01-01T00:00:00Z" })
const identity = { contractVersion: 3, catalogHash: "a".repeat(64) }

function release(version = "1.4.0", overrides = {}) {
  return hostEntries({
    version,
    channel: "stable",
    target: "darwin-arm64",
    releasedAt: "2026-10-11T00:00:00Z",
    ...identity,
    archive: { url: "https://example.test/host.tar.gz", sha256: "b".repeat(64), sizeBytes: 10 },
    ...overrides,
  })
}

describe("canonicalize", () => {
  it("sorts keys by UTF-16 code unit and drops undefined, like the client", () => {
    assert.equal(
      canonicalize({ b: 1, a: [2, { d: undefined, c: "x" }] }),
      '{"a":[2,{"c":"x"}],"b":1}'
    )
    // U+1F602 (D83D…) sorts before U+FB33 in UTF-16, after it in UTF-8.
    assert.equal(canonicalize({ דּ: 1, "\u{1F602}": 2 }), '{"\u{1F602}":2,"דּ":1}')
  })
})

describe("keys", () => {
  it("derives the same key and id from a seed every time", () => {
    const again = keyFromSeed(FIXTURE_SEEDS.root)
    assert.equal(again.publicKey, keys.root.publicKey)
    assert.match(again.keyid, /^[0-9a-f]{64}$/)
    assert.throws(() => keyFromSeed("nope"), /32 bytes/)
  })

  it("writes one private key per role and never overwrites one", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-keys-"))
    try {
      const written = keygen(dir, FIXTURE_SEEDS)
      assert.equal(written.targets.keyid, keys.targets.keyid)
      assert.equal(statSync(join(dir, "root.key.json")).mode & 0o777, 0o600)
      assert.equal(readRoleKeys(dir).snapshot.publicKey, keys.snapshot.publicKey)
      assert.throws(() => keygen(dir), /never overwritten/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("root", () => {
  it("names one key per role and encodes the trust root for both clients", () => {
    assert.deepEqual(Object.keys(root.signed.roles).sort(), [...ROLES].sort())
    const decoded = JSON.parse(Buffer.from(trustRootEnvValue(root), "base64").toString("utf8"))
    assert.deepEqual(decoded, root.signed)
  })

  it("has a rotated root co-signed by the root it replaces", () => {
    const rotated = keyFromSeed("5".repeat(64))
    const next = buildRoot(
      { ...keys, root: rotated },
      {
        version: 2,
        expires: "2036-01-01T00:00:00Z",
        previousRootKeys: [keys.root],
      }
    )
    assert.deepEqual(
      next.signatures.map((s) => s.keyid),
      [rotated.keyid, keys.root.keyid]
    )
    // A client trusting the old root accepts it.
    const bundle = signCatalog({
      keys: { ...keys, root: rotated },
      root: next,
      entries: release(),
      now: FIXTURE_NOW,
    })
    assert.equal(verifyCatalog(bundle, root.signed, FIXTURE_NOW).version, 1)
  })
})

describe("host entries", () => {
  it("publishes a release as a server entry with the artifact and a brain entry with its identity", () => {
    const [server, brain] = release()
    assert.equal(server.kind, "host-server")
    assert.equal(server.sha256, "b".repeat(64))
    assert.equal(brain.kind, "host-brain")
    assert.equal(brain.url, undefined)
    assert.equal(brain.contractVersion, server.contractVersion)
  })

  it("pins a Compose host to an image digest", () => {
    const [server] = hostEntries({
      version: "1.4.0",
      channel: "stable",
      target: "oci-full-amd64",
      releasedAt: "2026-10-11T00:00:00Z",
      ...identity,
      image: { repository: "ghcr.io/o/cognia-server", digest: `sha256:${"d".repeat(64)}` },
    })
    assert.equal(server.digest, `sha256:${"d".repeat(64)}`)
    assert.throws(
      () =>
        hostEntries({
          version: "1.4.0",
          channel: "stable",
          target: "oci-full-amd64",
          releasedAt: "x",
          ...identity,
          image: { repository: "ghcr.io/o/cognia-server:latest", digest: "latest" },
        }),
      /without a tag or digest[\s\S]*sha256: digest/
    )
  })

  it("refuses a half-published release, a contract split and a half revocation", () => {
    const [server, brain] = release()
    assert.match(entryProblems([server]).join(), /no host-brain entry/)
    assert.match(entryProblems([brain]).join(), /no host-server entry/)
    assert.match(
      entryProblems([server, { ...brain, contractVersion: 4 }]).join(),
      /different contracts/
    )
    assert.match(
      entryProblems([{ ...server, revoked: true }, brain]).join(),
      /revoke the server and brain together/
    )
    assert.match(entryProblems([server, brain, brain]).join(), /listed twice/)
    assert.match(entryProblems([{ ...server, url: "http://plain" }, brain]).join(), /https url/)
    assert.deepEqual(entryProblems([server, brain]), [])
  })

  it("leaves other kinds alone", () => {
    assert.deepEqual(entryProblems([{ kind: "desktop", assetId: "app", version: "1.0.0" }]), [])
  })

  it("reads this tree's contract identity", () => {
    const repo = repoContractIdentity()
    assert.ok(Number.isInteger(repo.contractVersion))
    assert.match(repo.catalogHash, /^[0-9a-f]{64}$/)
  })

  it("stages only the server rows, split into the Worker's target and arch", () => {
    const bodies = hostStageBodies([...release(), ...release("1.5.0", { channel: "beta" })])
    assert.equal(bodies.length, 2)
    assert.deepEqual(
      {
        target: bodies[0].target,
        arch: bodies[0].arch,
        digest: bodies[0].digest,
        kind: bodies[0].kind,
      },
      { target: "darwin", arch: "arm64", digest: "b".repeat(64), kind: "host-server" }
    )
    const [image] = hostStageBodies(
      hostEntries({
        version: "1.4.0",
        channel: "stable",
        target: "oci-slim-amd64",
        releasedAt: "2026-10-11T00:00:00Z",
        ...identity,
        image: { repository: "ghcr.io/o/cognia-server", digest: `sha256:${"d".repeat(64)}` },
      })
    )
    assert.deepEqual(
      [image.target, image.arch, image.url],
      ["oci-slim", "amd64", "ghcr.io/o/cognia-server"]
    )
  })
})

describe("signing", () => {
  it("signs a catalog the client checks accept, one version past the previous bundle", () => {
    const first = signCatalog({ keys, root, entries: release(), now: FIXTURE_NOW })
    assert.equal(verifyCatalog(first, root.signed, FIXTURE_NOW).version, 1)
    const second = signCatalog({
      keys,
      root,
      entries: release("1.5.0"),
      previous: first,
      now: FIXTURE_NOW,
    })
    assert.deepEqual(
      [
        second.targets.signed.version,
        second.snapshot.signed.version,
        second.timestamp.signed.version,
      ],
      [2, 2, 2]
    )
  })

  it("refuses to sign what a host would refuse", () => {
    const [server] = release()
    assert.throws(
      () => signCatalog({ keys, root, entries: [server], now: FIXTURE_NOW }),
      /refusing to sign/
    )
  })

  it("rejects a tampered entry, a foreign key and a stale bundle", () => {
    const bundle = signCatalog({ keys, root, entries: release(), now: FIXTURE_NOW })
    const tampered = structuredClone(bundle)
    tampered.targets.signed.entries[0].sha256 = "e".repeat(64)
    assert.throws(() => verifyCatalog(tampered, root.signed, FIXTURE_NOW), /targets: 0 valid/)

    // A key the root does not name: the signer refuses to emit it at all.
    const stranger = keyFromSeed("6".repeat(64))
    assert.throws(
      () =>
        signCatalog({
          keys: { ...keys, targets: stranger },
          root,
          entries: release(),
          now: FIXTURE_NOW,
        }),
      /targets: 0 valid/
    )

    assert.throws(
      () => verifyCatalog(bundle, root.signed, FIXTURE_NOW + 400 * 86_400_000),
      /expired/
    )
  })
})

describe("fixture", () => {
  it("is what the tool builds today", () => {
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))
    assert.deepEqual(committed, JSON.parse(JSON.stringify(buildFixture())))
    assert.equal(
      verifyCatalog(committed.bundle, committed.trustRoot, FIXTURE_NOW).entries.length,
      8
    )
  })
})

describe("cli", () => {
  it("parses flags and repeats --also-sign", () => {
    assert.deepEqual(parseArgs(["root", "--keys", "k", "--also-sign", "a", "--also-sign", "b"]), {
      command: "root",
      options: { _: [], keys: "k", "also-sign": ["a", "b"] },
    })
    assert.throws(() => parseArgs(["sign", "--keys"]), /needs a value/)
  })

  it("goes from keys to a verified bundle through the commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "update-cli-"))
    const log = console.log
    console.log = () => {}
    try {
      const archive = join(dir, "host.tar.gz")
      writeFileSync(archive, "archive bytes")
      await main(["keygen", "--keys", join(dir, "keys")])
      await main([
        "root",
        "--keys",
        join(dir, "keys"),
        "--version",
        "1",
        "--expires",
        "2099-01-01T00:00:00Z",
        "--out",
        join(dir, "root.json"),
      ])
      await main([
        "host-entries",
        "--version",
        "1.4.0",
        "--channel",
        "stable",
        "--target",
        "darwin-arm64",
        "--archive",
        archive,
        "--url",
        "https://example.test/host.tar.gz",
        "--out",
        join(dir, "entries.json"),
      ])
      await main([
        "host-entries",
        "--version",
        "1.4.0",
        "--channel",
        "stable",
        "--target",
        "oci-full-amd64",
        "--image",
        "ghcr.io/o/cognia-server",
        "--digest",
        `sha256:${"f".repeat(64)}`,
        "--out",
        join(dir, "entries.json"),
      ])
      await main([
        "sign",
        "--keys",
        join(dir, "keys"),
        "--root",
        join(dir, "root.json"),
        "--entries",
        join(dir, "entries.json"),
        "--out",
        join(dir, "bundle.json"),
      ])
      await main(["verify", "--bundle", join(dir, "bundle.json"), "--root", join(dir, "root.json")])
      const entries = JSON.parse(readFileSync(join(dir, "entries.json"), "utf8"))
      assert.equal(entries.length, 4)
      assert.equal(entries[0].sizeBytes, "archive bytes".length)
      await assert.rejects(main(["bogus"]), /usage:/)
    } finally {
      console.log = log
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
