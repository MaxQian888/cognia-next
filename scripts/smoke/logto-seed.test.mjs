import assert from "node:assert/strict"
import { test } from "node:test"

import {
  Management,
  connectorCallbacks,
  ensureApplication,
  NATIVE_CALLBACK_URI,
  envLines,
  ensureOrganizationRoles,
  ensureSignInExperience,
  nativeRedirectUris,
  planConnectors,
  webRedirectUris,
} from "./logto-seed.mjs"

test("adding Feishu preserves password login, MFA, account linking and existing providers", async () => {
  const experience = {
    socialSignInConnectorTargets: ["github"],
    signUp: { identifiers: ["username"], password: true, verify: false },
    signIn: { methods: [{ identifier: "username", password: true, verificationCode: false }] },
    socialSignIn: { automaticAccountLinking: false },
    mfa: { factors: ["Totp", "BackupCode"], policy: "Mandatory" },
  }
  const before = structuredClone(experience)
  const writes = []
  const api = {
    async get(path) {
      assert.equal(path, "/api/sign-in-exp")
      return structuredClone(experience)
    },
    async patch(path, body) {
      assert.equal(path, "/api/sign-in-exp")
      writes.push(body)
      Object.assign(experience, body)
    },
  }
  assert.deepEqual(await ensureSignInExperience(api, ["feishu-web"]), ["github", "feishu-web"])
  assert.deepEqual(writes, [{ socialSignInConnectorTargets: ["github", "feishu-web"] }])
  assert.deepEqual(experience, {
    ...before,
    socialSignInConnectorTargets: ["github", "feishu-web"],
  })
  await ensureSignInExperience(api, ["feishu-web"])
  assert.equal(writes.length, 1, "a second run must not rewrite the experience")
  assert.deepEqual(await ensureSignInExperience(api, []), ["github", "feishu-web"])
  assert.equal(writes.length, 1, "missing credentials must not remove enabled providers")
})

test("Cognia applications issue rotating refresh tokens for organization adoption", async () => {
  const writes = []
  const api = {
    async post(path, body) {
      writes.push(body)
      return { id: "new", ...body }
    },
    async patch(path, body) {
      writes.push(body)
      return body
    },
  }
  await ensureApplication(api, [], "Cognia", "Native", ["cognia://logto/callback"])
  assert.deepEqual(writes[0].customClientMetadata, {
    alwaysIssueRefreshToken: true,
    rotateRefreshToken: true,
    refreshTokenTtlInDays: 7,
  })
  await ensureApplication(
    api,
    [
      {
        id: "existing",
        name: "Cognia",
        type: "SPA",
        oidcClientMetadata: { redirectUris: ["http://localhost:3000/logto/callback"] },
        customClientMetadata: {
          corsAllowedOrigins: ["http://localhost:3000"],
          refreshTokenTtlInDays: 3,
        },
      },
    ],
    "Cognia",
    "SPA",
    ["http://localhost:3000/logto/callback"]
  )
  assert.deepEqual(writes[1].customClientMetadata, {
    corsAllowedOrigins: ["http://localhost:3000"],
    refreshTokenTtlInDays: 3,
    alwaysIssueRefreshToken: true,
    rotateRefreshToken: true,
  })
})

test("Management accepts the plain-text Created response from relation routes", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("Created", {
        status: 201,
        headers: { "content-type": "text/plain" },
      })
  )
  assert.deepEqual(
    await new Management("http://localhost", "test-token", false).post(
      "/api/organization-roles/owner/resource-scopes",
      { scopeIds: ["rpc"] }
    ),
    {}
  )
})

test("dry-run output never includes connector credentials", async (t) => {
  const output = []
  t.mock.method(console, "log", (line) => output.push(line))
  await new Management("http://localhost", "test-token", true).post("/api/connectors", {
    config: { clientSecret: "private-credential" },
  })
  assert.ok(output[0].includes("fields=config"))
  assert.ok(!output.join("").includes("private-credential"))
})

test("organization roles grant API scopes and never grant host admin to members", async () => {
  const writes = []
  const scopes = ["brain:rpc", "brain:read", "brain:admin", "collab:read", "collab:write"].map(
    (name) => ({ name, id: `scope-${name}` })
  )
  const api = {
    async get(path) {
      if (path === "/api/organization-roles") return [{ id: "owner-id", name: "owner" }]
      if (path === "/api/resources/resource-id/scopes") return scopes
      if (path.endsWith("/resource-scopes")) return [scopes[0]]
      throw new Error(`Unexpected GET ${path}`)
    },
    async post(path, body) {
      writes.push({ path, body })
      return path === "/api/organization-roles" ? { id: "member-id", ...body } : {}
    },
  }
  await ensureOrganizationRoles(api, { id: "resource-id" })
  const owner = writes.find((write) => write.path.includes("owner-id/resource-scopes"))
  const member = writes.find((write) => write.path.includes("member-id/resource-scopes"))
  assert.deepEqual(
    owner.body.scopeIds,
    scopes.slice(1).map((scope) => scope.id)
  )
  assert.deepEqual(member.body.scopeIds, [
    "scope-brain:read",
    "scope-collab:read",
    "scope-collab:write",
  ])
  assert.ok(!member.body.scopeIds.includes("scope-brain:admin"))
})

test("seeding fully configured organization roles performs no writes", async () => {
  const scopes = ["brain:rpc", "brain:read", "brain:admin", "collab:read", "collab:write"].map(
    (name) => ({ name, id: name })
  )
  await ensureOrganizationRoles(
    {
      async get(path) {
        if (path === "/api/organization-roles")
          return [
            { id: "owner", name: "owner" },
            { id: "member", name: "member" },
          ]
        return scopes
      },
      async post() {
        assert.fail("idempotent seed must not write")
      },
    },
    { id: "resource-id" }
  )
})

const factories = [
  { id: "github", target: "github", platform: "Universal" },
  { id: "feishu-web", target: "feishu", platform: "Web" },
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
  assert.deepEqual(plan.targets, ["github", "feishu"])
  assert.deepEqual(
    plan.create.map((item) => [item.connectorId, item.target]),
    [
      ["github", "github"],
      ["feishu-web", "feishu"],
    ]
  )
  assert.deepEqual(plan.create[1].config, { appId: "cli_x", appSecret: "fs" })
  assert.deepEqual(plan.update, [])
  assert.deepEqual(plan.skipped, [])
})

test("provider callbacks use actual connector instance IDs and only enabled providers", () => {
  assert.deepEqual(
    connectorCallbacks(
      "http://logto.localhost:3301/",
      [
        { id: "instance123", connectorId: "feishu-web", target: "feishu" },
        { id: "other456", connectorId: "github", target: "github" },
      ],
      ["feishu"]
    ),
    [{ target: "feishu", uri: "http://logto.localhost:3301/callback/instance123" }]
  )
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
