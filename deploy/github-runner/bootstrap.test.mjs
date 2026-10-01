import { test } from "node:test"
import assert from "node:assert/strict"
import { createECDH, createDecipheriv, hkdfSync } from "node:crypto"
import { readFileSync, existsSync, statSync } from "node:fs"
import {
  readConfiguration,
  parseInvitation,
  encryptPairing,
  hostArguments,
  cleanup,
  withRegistryConfiguration,
  prepareImages,
  initializeHostState,
} from "./bootstrap.mjs"

const recipient = createECDH("prime256v1")
recipient.generateKeys()
const leaseId = "ac083bcc-7158-4114-9aa5-e1b56295120b"
const env = {
  COGNIA_RUNNER_LEASE_ID: leaseId,
  COGNIA_RUNNER_LIFETIME_MINUTES: "60",
  COGNIA_RUNNER_HOST_IMAGE: `ghcr.io/example/host@sha256:${"a".repeat(64)}`,
  COGNIA_RUNNER_AGENT_BUNDLE_IMAGE: `ghcr.io/example/bundle@sha256:${"b".repeat(64)}`,
  COGNIA_RUNNER_DEVELOPMENT_IMAGE: `ghcr.io/example/dev@sha256:${"c".repeat(64)}`,
  COGNIA_RUNNER_SIGNALING_URL: "wss://relay.example/signaling",
  COGNIA_RUNNER_RECIPIENT_PUBLIC_KEY: recipient.getPublicKey().toString("base64"),
  GITHUB_RUN_ID: "12345",
}
const invitation = (version = 4, exp = Date.now() + 300_000) =>
  `cgnp${version}|${Buffer.from(JSON.stringify({ host: "host-id", exp, relay: { url: "wss://relay.example/signaling" } })).toString("base64url")}`

test("private registry configuration is scoped, private, and removed after success or failure", async () => {
  const secret = JSON.stringify({
    auths: { "ghcr.io": { username: "reader", password: "fake-token" } },
  })
  let configPath
  await withRegistryConfiguration(secret, async (path) => {
    configPath = path
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const config = JSON.parse(readFileSync(path, "utf8"))
    assert.deepEqual(config, { auths: { "ghcr.io": { auth: "cmVhZGVyOmZha2UtdG9rZW4=" } } })
  })
  assert.equal(existsSync(configPath), false)
  await assert.rejects(
    withRegistryConfiguration(secret, async (path) => {
      configPath = path
      throw new Error("pull failed")
    }),
    /pull failed/
  )
  assert.equal(existsSync(configPath), false)
  for (const invalid of [
    "fake-secret",
    '{"credsStore":"helper"}',
    '{"auths":{"ghcr.io/path":{"auth":"eDp5"}}}',
    '{"auths":{"ghcr.io":{"auth":"fake-secret"}}}',
    '{"auths":{"ghcr.io":{"password":"fake-secret"}}}',
  ]) {
    await assert.rejects(
      withRegistryConfiguration(invalid, async () => assert.fail("must not run")),
      (error) => {
        assert.equal(error.message, "Invalid runner registry credentials")
        assert.ok(!error.message.includes("fake-secret"))
        return true
      }
    )
  }
})

test("parallel pulls await all children before releasing credentials and redact failures", async () => {
  let release
  let slowFinished = false
  const slow = new Promise((resolve) => {
    release = resolve
  })
  const calls = []
  const config = readConfiguration(env)
  const operation = withRegistryConfiguration("", async (path) => {
    await prepareImages(
      config,
      path,
      Date.now() + 60_000,
      undefined,
      async (args) => {
        calls.push(args)
        if (args.at(-1) === config.images[0]) throw new Error("secret registry output")
        await slow
        assert.equal(existsSync(path), true)
        slowFinished = true
      },
      () => {}
    )
  })
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await assert.rejects(operation, /Host image pull failed/)
  assert.equal(slowFinished, true)
  assert.equal(calls.length, 3)
  assert.ok(calls.every((args) => args[0] === "--config" && args[2] === "pull"))
})

test("refuses mutable images, command injection, secret endpoints and invalid lease budgets", () => {
  assert.equal(readConfiguration(env).lifetimeMinutes, 60)
  for (const patch of [
    { COGNIA_RUNNER_HOST_IMAGE: "ubuntu:latest" },
    { COGNIA_RUNNER_HOST_IMAGE: `x;echo foo@sha256:${"a".repeat(64)}` },
    { COGNIA_RUNNER_SIGNALING_URL: "wss://user:secret@relay.example" },
    { COGNIA_RUNNER_SIGNALING_URL: "wss://relay.example?token=secret" },
    { COGNIA_RUNNER_LIFETIME_MINUTES: "331" },
    { COGNIA_RUNNER_LIFETIME_MINUTES: "9" },
    { COGNIA_RUNNER_LEASE_ID: "../../data" },
    { COGNIA_RUNNER_RECIPIENT_PUBLIC_KEY: Buffer.alloc(65).toString("base64") },
  ])
    assert.throws(() => readConfiguration({ ...env, ...patch }))
})

test("publishes only live relay pairing invitations, never a loopback-only fallback", () => {
  assert.equal(parseInvitation(`header\n    ${invitation()}\nfooter`).hostId, "host-id")
  assert.throws(() => parseInvitation(invitation(3)))
  assert.throws(() => parseInvitation(invitation(4, Date.now())))
})

test("pairing wire decrypts only for its recipient, lease and workflow run", () => {
  const config = readConfiguration(env)
  const payload = parseInvitation(invitation())
  const envelope = encryptPairing(config, payload)
  assert.ok(!JSON.stringify(envelope).includes(payload.invitation))
  const shared = recipient.computeSecret(Buffer.from(envelope.ephemeralPublicKey, "base64"))
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.from(leaseId),
      Buffer.from("cognia-github-runner-pairing-v1"),
      32
    )
  )
  const bytes = Buffer.from(envelope.ciphertext, "base64")
  const decrypt = (runId) => {
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"))
    cipher.setAAD(Buffer.from(`${leaseId}:${runId}`))
    cipher.setAuthTag(bytes.subarray(-16))
    return JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString("utf8")
    )
  }
  assert.deepEqual(decrypt(config.runId), payload)
  assert.throws(() => decrypt(config.runId + 1))
})

test("Host owns named workspaces and receives no GitHub or artifact credentials", () => {
  const args = hostArguments(
    readConfiguration({
      ...env,
      GITHUB_TOKEN: "do-not-forward",
      COGNIA_RUNNER_REGISTRY_AUTH: "private-registry-secret",
    }),
    999
  )
  assert.ok(args.includes(`COGNIA_WORKSPACES_VOLUME=cognia-${leaseId}-workspaces`))
  assert.ok(args.includes("COGNIA_SANDBOX_POOL_ENABLED=true"))
  assert.ok(args.includes("COGNIA_EXEC_BACKEND=local-process"))
  assert.ok(args.includes("COGNIA_MASTER_KEY_FILE=/data/master-key"))
  assert.ok(args.includes("COGNIA_REGISTRY_AUTH_FILE=/data/registry-auth.json"))
  assert.ok(args.includes(`COGNIA_DEPLOYMENT_ID=cognia-${leaseId}`))
  assert.ok(args.includes("--bind-loopback"))
  assert.ok(!args.includes("--publish"))
  assert.ok(!args.join(" ").includes("do-not-forward"))
  assert.ok(!args.join(" ").includes("GITHUB_TOKEN"))
  assert.ok(!args.join(" ").includes("private-registry-secret"))
})

test("private registry admission uses the Host data volume without secret command arguments", async () => {
  const calls = []
  await withRegistryConfiguration('{"auths":{"ghcr.io":{"auth":"eDp5"}}}', async (path) => {
    await initializeHostState(readConfiguration(env), path, async (args) => {
      calls.push(args)
      assert.ok(!args.join(" ").includes("eDp5"))
      if (args[0] === "run") {
        assert.ok(args.includes(`type=bind,src=${path},dst=/registry/config.json,readonly`))
        assert.ok(args.includes(`type=volume,src=cognia-${leaseId}-data,dst=/data`))
        assert.match(args.at(-1), /registry-auth\.json/)
        assert.match(args.at(-1), /mode:0o600,flag:'wx'/)
        assert.match(args.at(-1), /chownSync\(p,10001,10001\)/)
      }
    })
  })
  assert.equal(calls.length, 3)
})

test("cleanup scopes to the lease and removes children before workspace volumes", async () => {
  const calls = []
  await cleanup(leaseId, async (args) => {
    calls.push(args)
    if (args[0] === "ps") return "abc123\ndef456\n"
    if (args[0] === "volume" && args[1] === "ls") return "bundle-volume\n"
    return ""
  })
  assert.deepEqual(calls[0], ["rm", "--force", `cognia-${leaseId}`])
  assert.ok(calls[1].includes(`label=cognia.deployment=cognia-${leaseId}`))
  assert.deepEqual(calls[2], ["rm", "--force", "abc123", "def456"])
  assert.equal(calls.at(-1).at(-1), `cognia-${leaseId}-workspaces`)
  await assert.rejects(
    cleanup("../other", async () => {
      throw new Error("must not execute")
    })
  )
})

test("workflow only accepts explicit trusted actors and always releases resources", () => {
  const workflow = readFileSync(new URL("./cognia-runner.yml", import.meta.url), "utf8")
  assert.match(
    workflow,
    /contains\(fromJSON\(vars.COGNIA_RUNNER_ACTORS \|\| '\[\]'\), github.actor\)/
  )
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /if: always\(\)/)
  assert.match(workflow, /uses: \.\/\.github\/cognia-runner/)
  assert.match(readFileSync(new URL("./action.yml", import.meta.url), "utf8"), /using: node24/)
  assert.deepEqual(workflow.match(/secrets\.[A-Z_]+/g), ["secrets.COGNIA_RUNNER_REGISTRY_AUTH"])
  assert.ok(!workflow.includes("inputs.registry"))
  assert.ok(!workflow.includes("pull_request"))
  assert.ok(!workflow.includes("actions: write"))
})
