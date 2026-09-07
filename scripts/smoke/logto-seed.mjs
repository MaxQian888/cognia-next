#!/usr/bin/env node
/**
 * Seed a self-hosted Logto for Cognia Cloud, idempotently, from the command
 * line (deploy/compose/LOGTO.md sections 2, 5, 6 and 8).
 *
 * The one thing that stays manual is creating a machine-to-machine
 * application in the Admin Console with the Logto Management API `all` scope.
 * Everything else the runbook used to ask a person to click through is
 * upserted here by name, so a second run changes nothing and a redeploy
 * reproduces the tenant:
 *
 *   - the API resource (the gateway audience) and its scopes,
 *   - the Native application (desktop + phone + CLI) with the deep-link and
 *     loopback redirect URIs,
 *   - the SPA application (web) with `<web origin>/logto/callback`,
 *   - the organization roles collab-server assigns (`owner`, `member`),
 *   - the social connectors (GitHub, Feishu) from their factories, and
 *   - the sign-in experience, social-only unless told otherwise.
 *
 * Connector targets are READ from `GET /api/connector-factories`, never
 * assumed: Logto's Feishu connector is `@logto/connector-feishu-web` and its
 * target is `feishu-web`, which is what `COGNIA_LOGTO_SOCIAL_PROVIDERS` must
 * carry and what the client passes as `direct_sign_in`. The script prints the
 * `.env` lines with the real values at the end.
 *
 * Environment:
 *   LOGTO_ENDPOINT             Logto's public base, e.g. http://logto:3001 (not /oidc)
 *   LOGTO_M2M_CLIENT_ID        the M2M app id
 *   LOGTO_M2M_CLIENT_SECRET    its secret
 *   COGNIA_LOGTO_AUDIENCE      API resource indicator, e.g. https://localhost/api
 *   COGNIA_WEB_ORIGIN          the web app's origin, e.g. https://localhost
 *   LOGTO_GITHUB_CLIENT_ID / LOGTO_GITHUB_CLIENT_SECRET       (optional)
 *   LOGTO_FEISHU_APP_ID / LOGTO_FEISHU_APP_SECRET             (optional)
 *   LOGTO_CLI_LOOPBACK_PORTS   comma-separated, default 9321
 *   LOGTO_MANAGEMENT_RESOURCE  default https://default.logto.app/api
 *   --dry-run                  plan only, no writes
 */

import { argv, env, exit } from "node:process"

const MANAGEMENT_RESOURCE = env.LOGTO_MANAGEMENT_RESOURCE ?? "https://default.logto.app/api"
export const NATIVE_CALLBACK_URI = "cognia://logto/callback"
export const API_SCOPES = [
  { name: "brain:rpc", description: "Call the companion RPC surface" },
  { name: "brain:read", description: "Read companion state" },
  { name: "brain:admin", description: "Administer the companion host" },
  { name: "collab:read", description: "Read the collaboration plane" },
  { name: "collab:write", description: "Write to the collaboration plane" },
]
export const ORGANIZATION_ROLES = [
  { name: "owner", description: "Owns the organization" },
  { name: "member", description: "Works in the organization" },
]

/** Which connector factories we want, and the environment that configures each. */
export const CONNECTOR_PLANS = [
  {
    /** Logto's GitHub connector. Target `github`. */
    factoryMatch: (factory) => factory.target === "github",
    label: "GitHub",
    envId: "LOGTO_GITHUB_CLIENT_ID",
    envSecret: "LOGTO_GITHUB_CLIENT_SECRET",
    config: (id, secret) => ({ clientId: id, clientSecret: secret, scope: "read:user user:email" }),
  },
  {
    /**
     * Logto's Feishu connector is `@logto/connector-feishu-web`. Its target
     * is what the factory says it is, which is why this matches on the id and
     * reads the target back rather than writing `feishu` from memory.
     */
    factoryMatch: (factory) =>
      factory.id === "feishu-web" || factory.target === "feishu-web" || factory.target === "feishu",
    label: "Feishu",
    envId: "LOGTO_FEISHU_APP_ID",
    envSecret: "LOGTO_FEISHU_APP_SECRET",
    config: (id, secret) => ({ appId: id, appSecret: secret }),
  },
]

/** Redirect URIs the Native application must accept. Pure, for the test. */
export function nativeRedirectUris(loopbackPorts) {
  const ports = (loopbackPorts ?? "9321")
    .split(",")
    .map((port) => port.trim())
    .filter(Boolean)
  return [NATIVE_CALLBACK_URI, ...ports.map((port) => `http://127.0.0.1:${port}/callback`)]
}

/** Redirect URIs the SPA application must accept. Pure, for the test. */
export function webRedirectUris(webOrigin) {
  const origin = new URL(webOrigin).origin
  return [`${origin}/logto/callback`]
}

/**
 * Decide which connectors to create or update from the factories Logto
 * offers and the credentials the environment holds. Pure, for the test.
 *
 * Returns `{ create, update, skipped, targets }`: `targets` is the ordered
 * connector-target list for `COGNIA_LOGTO_SOCIAL_PROVIDERS`.
 */
export function planConnectors(factories, existing, environment) {
  const create = []
  const update = []
  const skipped = []
  const targets = []
  for (const plan of CONNECTOR_PLANS) {
    const id = environment[plan.envId]
    const secret = environment[plan.envSecret]
    if (!id || !secret) {
      skipped.push({ label: plan.label, reason: `${plan.envId} / ${plan.envSecret} unset` })
      continue
    }
    const factory = factories.find(plan.factoryMatch)
    if (!factory) {
      skipped.push({ label: plan.label, reason: "no connector factory offers it" })
      continue
    }
    const config = plan.config(id, secret)
    const found = existing.find((connector) => connector.connectorId === factory.id)
    if (found) update.push({ label: plan.label, id: found.id, target: factory.target, config })
    else create.push({ label: plan.label, connectorId: factory.id, target: factory.target, config })
    targets.push(factory.target)
  }
  return { create, update, skipped, targets }
}

/** The `.env` lines a deployment needs once the tenant is seeded. Pure. */
export function envLines(input) {
  const lines = [
    `COGNIA_LOGTO_ISSUER=${input.endpoint.replace(/\/+$/, "")}/oidc`,
    `COGNIA_LOGTO_AUDIENCE=${input.audience}`,
    `COGNIA_LOGTO_WEB_CLIENT_ID=${input.webClientId}`,
    `COGNIA_LOGTO_NATIVE_CLIENT_ID=${input.nativeClientId}`,
    `COGNIA_LOGTO_REQUIRED_SCOPES=brain:rpc`,
    `COGNIA_LOGTO_SOCIAL_PROVIDERS=${input.targets.join(",")}`,
    `COGNIA_WEB_ORIGIN=${new URL(input.webOrigin).origin}`,
    `COLLAB_OIDC_ISSUER=${input.endpoint.replace(/\/+$/, "")}/oidc`,
    `COLLAB_OIDC_AUDIENCE=${input.audience}`,
    `COLLAB_LOGTO_ENDPOINT=${input.endpoint.replace(/\/+$/, "")}`,
    `COLLAB_LOGTO_M2M_CLIENT_ID=${input.m2mClientId}`,
    `COLLAB_LOGTO_M2M_CLIENT_SECRET=<the M2M secret>`,
  ]
  return lines
}

// ---------------------------------------------------------------------------
// Management API client
// ---------------------------------------------------------------------------

class Management {
  constructor(endpoint, token, dryRun) {
    this.endpoint = endpoint.replace(/\/+$/, "")
    this.token = token
    this.dryRun = dryRun
  }

  async call(method, path, body) {
    if (this.dryRun && method !== "GET") {
      console.log(`[dry-run] ${method} ${path} ${body ? JSON.stringify(body) : ""}`)
      return {}
    }
    const response = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${method} ${path} answered ${response.status}: ${text}`)
    }
    return text ? JSON.parse(text) : {}
  }

  get(path) {
    return this.call("GET", path)
  }
  post(path, body) {
    return this.call("POST", path, body)
  }
  patch(path, body) {
    return this.call("PATCH", path, body)
  }
}

async function managementToken(endpoint, clientId, clientSecret) {
  const response = await fetch(`${endpoint.replace(/\/+$/, "")}/oidc/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource: MANAGEMENT_RESOURCE,
      scope: "all",
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `the M2M application could not get a Management API token (${response.status}): ${text}\n` +
        "Create it in the Admin Console (Applications > Machine-to-machine) and grant it the " +
        "Logto Management API resource with the `all` scope."
    )
  }
  return JSON.parse(text).access_token
}

// ---------------------------------------------------------------------------
// Seeding steps, each idempotent by name
// ---------------------------------------------------------------------------

async function ensureResource(api, audience) {
  const resources = await api.get("/api/resources")
  let resource = resources.find((row) => row.indicator === audience)
  if (!resource) {
    resource = await api.post("/api/resources", {
      name: "Cognia Cloud API",
      indicator: audience,
      accessTokenTtl: 3600,
    })
    console.log(`created API resource ${audience}`)
  } else {
    console.log(`API resource ${audience} present`)
  }
  if (!resource.id) return resource
  const scopes = await api.get(`/api/resources/${resource.id}/scopes`)
  for (const scope of API_SCOPES) {
    if (scopes.some((row) => row.name === scope.name)) continue
    await api.post(`/api/resources/${resource.id}/scopes`, scope)
    console.log(`  added scope ${scope.name}`)
  }
  return resource
}

async function ensureApplication(api, applications, name, type, redirectUris) {
  let application = applications.find((row) => row.name === name && row.type === type)
  const metadata = { redirectUris, postLogoutRedirectUris: [] }
  if (!application) {
    application = await api.post("/api/applications", {
      name,
      type,
      oidcClientMetadata: metadata,
    })
    console.log(`created ${type} application "${name}" (${application.id ?? "dry-run"})`)
    return application
  }
  const current = application.oidcClientMetadata?.redirectUris ?? []
  const missing = redirectUris.filter((uri) => !current.includes(uri))
  if (missing.length > 0) {
    await api.patch(`/api/applications/${application.id}`, {
      oidcClientMetadata: {
        ...application.oidcClientMetadata,
        redirectUris: [...current, ...missing],
      },
    })
    console.log(`updated ${type} application "${name}": added ${missing.join(", ")}`)
  } else {
    console.log(`${type} application "${name}" present (${application.id})`)
  }
  return application
}

async function ensureOrganizationRoles(api) {
  const roles = await api.get("/api/organization-roles")
  for (const role of ORGANIZATION_ROLES) {
    if (roles.some((row) => row.name === role.name)) continue
    await api.post("/api/organization-roles", role)
    console.log(`created organization role ${role.name}`)
  }
}

async function ensureConnectors(api, environment) {
  const factories = await api.get("/api/connector-factories")
  const existing = await api.get("/api/connectors")
  const plan = planConnectors(factories, existing, environment)
  for (const item of plan.skipped) console.log(`skipping ${item.label}: ${item.reason}`)
  for (const item of plan.create) {
    await api.post("/api/connectors", {
      connectorId: item.connectorId,
      config: item.config,
      syncProfile: true,
    })
    console.log(`created ${item.label} connector (target ${item.target})`)
  }
  for (const item of plan.update) {
    await api.patch(`/api/connectors/${item.id}`, { config: item.config, syncProfile: true })
    console.log(`updated ${item.label} connector (target ${item.target})`)
  }
  return plan.targets
}

async function ensureSignInExperience(api, targets) {
  if (targets.length === 0) {
    console.log("no social connectors configured: sign-in experience left as is")
    return
  }
  await api.patch("/api/sign-in-exp", {
    socialSignInConnectorTargets: targets,
    signUp: { identifiers: [], password: false, verify: false },
    signIn: { methods: [] },
    socialSignIn: { automaticAccountLinking: true },
  })
  console.log(`sign-in experience: social only (${targets.join(", ")})`)
}

export async function seed(environment, { dryRun = false } = {}) {
  const endpoint = environment.LOGTO_ENDPOINT
  const clientId = environment.LOGTO_M2M_CLIENT_ID
  const clientSecret = environment.LOGTO_M2M_CLIENT_SECRET
  const audience = environment.COGNIA_LOGTO_AUDIENCE
  const webOrigin = environment.COGNIA_WEB_ORIGIN
  for (const [name, value] of Object.entries({
    LOGTO_ENDPOINT: endpoint,
    LOGTO_M2M_CLIENT_ID: clientId,
    LOGTO_M2M_CLIENT_SECRET: clientSecret,
    COGNIA_LOGTO_AUDIENCE: audience,
    COGNIA_WEB_ORIGIN: webOrigin,
  })) {
    if (!value) throw new Error(`${name} is required`)
  }

  const token = await managementToken(endpoint, clientId, clientSecret)
  const api = new Management(endpoint, token, dryRun)

  await ensureResource(api, audience)
  const applications = await api.get("/api/applications")
  const native = await ensureApplication(
    api,
    applications,
    "Cognia (native)",
    "Native",
    nativeRedirectUris(environment.LOGTO_CLI_LOOPBACK_PORTS)
  )
  const spa = await ensureApplication(
    api,
    applications,
    "Cognia (web)",
    "SPA",
    webRedirectUris(webOrigin)
  )
  await ensureOrganizationRoles(api)
  const targets = await ensureConnectors(api, environment)
  await ensureSignInExperience(api, targets)

  const lines = envLines({
    endpoint,
    audience,
    webOrigin,
    webClientId: spa.id ?? "<SPA app id>",
    nativeClientId: native.id ?? "<native app id>",
    m2mClientId: clientId,
    targets,
  })
  console.log("\nAdd to deploy/compose/.env:\n")
  for (const line of lines) console.log(`  ${line}`)
  if (targets.length > 0) {
    console.log("\nRegister these callback URLs at the identity providers:")
    for (const target of targets) {
      console.log(`  ${target}: ${endpoint.replace(/\/+$/, "")}/callback/${target}`)
    }
  }
  return { native, spa, targets, lines }
}

const invokedDirectly =
  typeof process !== "undefined" && argv[1] && import.meta.url === new URL(`file://${argv[1]}`).href
if (invokedDirectly) {
  seed(env, { dryRun: argv.includes("--dry-run") }).catch((error) => {
    console.error(`[logto-seed] ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  })
}
