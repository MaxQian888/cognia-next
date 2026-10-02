import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  challengeProof,
  contentBearer,
  deriveSessionKey,
  newClientNonce,
  nextSessionCredential,
  readBootstrapCredential,
} from "../src/broker-credential.mjs"

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8").then((text) => text.trim())

test("derivation matches the host's pinned test vector", async () => {
  // crates/cognia-codeserver/src/credential.rs pins the same two files.
  const key = deriveSessionKey(Buffer.from("bootstrap-secret"), "server-nonce", "client-nonce")
  assert.equal(key.toString("hex"), await fixture("session-key.vector"))
  assert.equal(
    contentBearer("session-id", key),
    `session-id.${await fixture("content-bearer.vector")}`
  )
})

test("session keys depend on the secret and both nonces", () => {
  const key = deriveSessionKey(Buffer.from("secret"), "server", "client")
  assert.equal(key.length, 32)
  assert.notDeepEqual(key, deriveSessionKey(Buffer.from("other"), "server", "client"))
  assert.notDeepEqual(key, deriveSessionKey(Buffer.from("secret"), "server2", "client"))
  assert.notDeepEqual(key, deriveSessionKey(Buffer.from("secret"), "server", "client2"))
})

test("a bootstrap file is read once and unlinked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cognia-broker-"))
  try {
    const path = join(dir, "instance.cred")
    await writeFile(path, JSON.stringify({ tokenId: "tok-1", secret: "s3cret" }))
    const credential = await readBootstrapCredential(path, { timeoutMs: 1000, intervalMs: 5 })
    assert.equal(credential.kind, "bootstrap")
    assert.equal(credential.tokenId, "tok-1")
    assert.deepEqual(credential.secret, Buffer.from("s3cret"))
    await assert.rejects(stat(path), { code: "ENOENT" })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a missing file is waited for, and a half-written one is retried, not deleted", async () => {
  const files = new Map()
  let clock = 0
  let sleeps = 0
  const fs = {
    readFile: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return files.get(path)
    },
    unlink: async (path) => {
      files.delete(path)
    },
  }
  const sleep = async (ms) => {
    clock += ms
    sleeps += 1
    if (sleeps === 1) files.set("/c", '{"tokenId":"tok"') // mid-write
    if (sleeps === 2) files.set("/c", '{"tokenId":"tok","secret":"s"}')
  }
  const credential = await readBootstrapCredential("/c", {
    fs,
    timeoutMs: 1000,
    intervalMs: 10,
    now: () => clock,
    sleep,
  })
  assert.equal(credential.tokenId, "tok")
  assert.equal(files.has("/c"), false)
  assert.equal(sleeps, 2)
})

test("an absent file eventually fails with a coded error", async () => {
  let clock = 0
  await assert.rejects(
    readBootstrapCredential("/nowhere", {
      fs: {
        readFile: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" })
        },
        unlink: async () => {},
      },
      timeoutMs: 50,
      intervalMs: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    }),
    /IDE_BROKER_CREDENTIAL_UNAVAILABLE/
  )
  await assert.rejects(readBootstrapCredential(""), /IDE_BROKER_CREDENTIAL_UNAVAILABLE/)
})

test("a successful hello replaces the presented credential with a derived session", () => {
  const bootstrap = { kind: "bootstrap", tokenId: "tok", secret: Buffer.from("s") }
  const session = nextSessionCredential(bootstrap, "server", "client", "session-1")
  assert.equal(session.kind, "session")
  assert.equal(session.tokenId, "session-1")
  assert.deepEqual(session.secret, deriveSessionKey(Buffer.from("s"), "server", "client"))
  // Reconnects rotate from the session itself.
  const rotated = nextSessionCredential(session, "server2", "client2", "session-2")
  assert.deepEqual(rotated.secret, deriveSessionKey(session.secret, "server2", "client2"))
  assert.throws(() => nextSessionCredential(bootstrap, "s", "c", ""), /NEGOTIATION_INVALID/)
})

test("challenge proofs are HMAC-SHA256 over the server nonce", () => {
  const proof = challengeProof(Buffer.from("key"), "nonce")
  assert.equal(proof, createHmac("sha256", "key").update("nonce").digest("hex"))
  assert.notEqual(proof, challengeProof(Buffer.from("key"), "other"))
  assert.notEqual(proof, challengeProof(Buffer.from("other-key"), "nonce"))
})

test("client nonces satisfy the host's length bounds and do not repeat", () => {
  const nonce = newClientNonce()
  assert.ok(nonce.length >= 16 && nonce.length <= 256)
  assert.notEqual(nonce, newClientNonce())
})
