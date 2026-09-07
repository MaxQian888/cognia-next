import assert from "node:assert/strict"
import { test } from "node:test"

import {
  NATIVE_CALLBACK_URI,
  envLines,
  nativeRedirectUris,
  planConnectors,
  webRedirectUris,
} from "./logto-seed.mjs"

const factories = [
  { id: "github", target: "github", platform: "Universal" },
  { id: "feishu-web", target: "feishu-web", platform: "Web" },
  { id: "google", target: "google", platform: "Universal" },
]

test("the native application accepts the deep link and every CLI loopback port", () => {
  assert.deepEqual(nativeRedirectUris(undefined), [
    NATIVE_CALLBACK_URI,
    "http://127.0.0.1:9321/callback",
  ])
  assert.deepEqual(nativeRedirectUris("9321, 9322"), [
    NATIVE_CALLBACK_URI,
    "http://127.0.0.1:9321/callback",
    "http://127.0.0.1:9322/callback",
  ])
})

test("the web application accepts exactly the callback route on the web origin", () => {
  assert.deepEqual(webRedirectUris("https://cognia.example.com/some/path"), [
    "https://cognia.example.com/logto/callback",
  ])
})

test("connector targets come from the factories, never from memory", () => {
  const plan = planConnectors(factories, [], {
    LOGTO_GITHUB_CLIENT_ID: "gh",
    LOGTO_GITHUB_CLIENT_SECRET: "ghs",
    LOGTO_FEISHU_APP_ID: "cli_x",
    LOGTO_FEISHU_APP_SECRET: "fs",
  })
  assert.deepEqual(plan.targets, ["github", "feishu-web"])
  assert.deepEqual(
    plan.create.map((item) => [item.connectorId, item.target]),
    [
      ["github", "github"],
      ["feishu-web", "feishu-web"],
    ]
  )
  assert.deepEqual(plan.create[1].config, { appId: "cli_x", appSecret: "fs" })
  assert.deepEqual(plan.update, [])
  assert.deepEqual(plan.skipped, [])
})

test("an existing connector is updated in place and a missing credential is skipped", () => {
  const plan = planConnectors(factories, [{ id: "conn_1", connectorId: "github" }], {
    LOGTO_GITHUB_CLIENT_ID: "gh",
    LOGTO_GITHUB_CLIENT_SECRET: "ghs",
  })
  assert.deepEqual(plan.create, [])
  assert.equal(plan.update.length, 1)
  assert.equal(plan.update[0].id, "conn_1")
  assert.deepEqual(plan.targets, ["github"])
  assert.equal(plan.skipped.length, 1)
  assert.match(plan.skipped[0].reason, /LOGTO_FEISHU_APP_ID/)
})

test("a factory Logto does not offer is reported, not invented", () => {
  const plan = planConnectors([factories[0]], [], {
    LOGTO_GITHUB_CLIENT_ID: "gh",
    LOGTO_GITHUB_CLIENT_SECRET: "ghs",
    LOGTO_FEISHU_APP_ID: "cli_x",
    LOGTO_FEISHU_APP_SECRET: "fs",
  })
  assert.deepEqual(plan.targets, ["github"])
  assert.match(plan.skipped[0].reason, /no connector factory/)
})

test("the env lines name the issuer under /oidc and list the real targets", () => {
  const lines = envLines({
    endpoint: "http://logto:3001/",
    audience: "https://localhost/api",
    webOrigin: "https://localhost/",
    webClientId: "spa1",
    nativeClientId: "nat1",
    m2mClientId: "m2m1",
    targets: ["github", "feishu-web"],
  })
  assert.ok(lines.includes("COGNIA_LOGTO_ISSUER=http://logto:3001/oidc"))
  assert.ok(lines.includes("COLLAB_OIDC_ISSUER=http://logto:3001/oidc"))
  assert.ok(lines.includes("COGNIA_LOGTO_SOCIAL_PROVIDERS=github,feishu-web"))
  assert.ok(lines.includes("COGNIA_WEB_ORIGIN=https://localhost"))
  assert.ok(lines.includes("COGNIA_LOGTO_WEB_CLIENT_ID=spa1"))
  assert.ok(lines.includes("COGNIA_LOGTO_NATIVE_CLIENT_ID=nat1"))
  assert.ok(
    !lines.some(
      (line) =>
        line.includes("<the M2M secret>") === false &&
        line.includes("SECRET=") &&
        !line.endsWith("=<the M2M secret>")
    )
  )
})
