/** @jest-environment jsdom */

/**
 * The GitHub Comment Bot end to end on the real host planes (plan §17).
 *
 * A signed webhook body is normalized by GitHub Delivery, stored and projected
 * by the Integration plane, routed and drained by the Bot plane, and answered
 * by the real Comment Bot handler through the real `ctx.bots` and
 * `ctx.integrations` APIs: memoized host steps, policy approvals, the action
 * broker with its approval references, and GitHub Delivery's own write
 * actions. Only two things are stand-ins: GitHub itself (a fetch-level fake
 * repository) and the two processes the host would spawn, the git checkout and
 * the external agent. Assertions count model calls and remote writes, not UI.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createIntegrationAccount } from "@/lib/db/integrations"
import { installBot, updateBotInstallation } from "@/lib/db/bot-installations"
import { __resetAuthRegistryForTesting, getSession } from "@/lib/plugin/auth/auth-provider-registry"
import {
  __resetBotsForTesting,
  botDefinitionId,
  registerBot,
} from "@/lib/plugin/registries/bot-registry"
import { createBotsAPI } from "@/lib/plugin/api/bots-api"
import { createIntegrationsAPI } from "@/lib/plugin/api/integrations-api"
import { drainBotDeliveries } from "@/lib/bot/runtime/delivery-runner"
import { __resetLiveBotRunsForTesting } from "@/lib/bot/runtime/run"
import { registerGithubIntegrationAuthProviders } from "./github-auth"
import { __resetIntegrationRegistryForTesting, registerIntegrationDefinitions } from "./registry"
import { publishIntegrationEvent, recoverIntegrationEventProjections } from "./events"
import { drainIntegrationActionJobs } from "./action-runner"
import { respondRunApproval } from "@/lib/execution/run-approvals"
import { installExecutionRunControlHandlers } from "@/lib/execution/control-handlers"
import {
  builtinArtifactManifest,
  loadBuiltinArtifactExports,
} from "@/lib/plugin/core/builtin-artifact-fixture"
import {
  AUTHOR,
  fakeGithub,
  issueComment,
  NOW,
  REPOSITORY,
  REPOSITORY_ID,
  routeFake,
  type FakeGithub,
} from "@cognia/github-bot-kit/testing"
import type { PluginIntegrationDef } from "@/types/plugin/plugin-integration"
import type { BotHandlerV1 } from "@/types/bot/run"
import type { RegisterIntegrationDefinitionsInput } from "./registry"
import type { PluginContext } from "@/types/plugin"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"

jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  findMatchingWorkflows: () => [],
}))
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: jest.fn(),
}))
// The binding checks that the Bot's plugin declares GitHub Delivery.
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: {
    getState: () => ({
      plugins: {
        "github-comment-bot": { manifest: { dependencies: { "github-delivery": ">=3.0.0" } } },
      },
    }),
  },
}))

const PLUGIN_ID = "github-comment-bot"
const TRIGGER = "@cognia-bot"

/** GitHub Delivery's entry exports, from the built-in chunk the app ships. */
interface GithubDeliveryExports {
  manifest: { id: string }
  githubIntegration: PluginIntegrationDef
  normalizeGithub: NonNullable<RegisterIntegrationDefinitionsInput["normalizers"]>[string]
  listGithubResources: NonNullable<RegisterIntegrationDefinitionsInput["resourceProviders"]>[string]
  checkGithubHealth: NonNullable<
    RegisterIntegrationDefinitionsInput["accountStatusProviders"]
  >[string]
  [handler: string]: unknown
}

// Both plugins come from the chunks the app ships, not from plugin source.
let delivery: GithubDeliveryExports
let githubCommentBotDef: unknown
let createGithubCommentBot: (context: PluginContext) => BotHandlerV1
/** `ctx.i18n.t` over the shipped plugin's own en bundle, as the host resolves it. */
let translate: (key: string, params?: Record<string, string | number>) => string

beforeAll(async () => {
  delivery = (await loadBuiltinArtifactExports("github-delivery")) as GithubDeliveryExports
  const commentBot = await loadBuiltinArtifactExports(PLUGIN_ID)
  githubCommentBotDef = commentBot.githubCommentBotDef
  createGithubCommentBot = commentBot.createGithubCommentBot as typeof createGithubCommentBot
  const en =
    (builtinArtifactManifest(PLUGIN_ID).i18n?.locales?.en as Record<string, string> | undefined) ??
    {}
  translate = (key, params) =>
    (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params?.[name] ?? `{${name}}`)
    )
})

interface RecordedRequest {
  method: string
  path: string
}

/** GitHub at the fetch boundary: the plugin's fake repository, plus the writes Delivery makes. */
interface GithubFaults {
  /** Store the next matching comment, then lose the response (A8). */
  loseCreateResponse?: (body: string) => boolean
}

function githubFetch(github: FakeGithub, requests: RecordedRequest[], faults: GithubFaults) {
  const read = routeFake(github)
  let nextId = 7000
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  return jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    requests.push({ method, path: `${url.pathname}${url.search}` })
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const repo = `/repos/${REPOSITORY}`
    if (method === "POST") {
      const match = new RegExp(`^${repo}/issues/(\\d+)/comments$`).exec(url.pathname)
      if (!match) throw new Error(`Unexpected GitHub write ${method} ${url.pathname}`)
      const id = nextId++
      const comment = issueComment(id, String(body.body), {
        user: { ...github.viewer, type: "Bot" },
        created_at: new Date(Date.now()).toISOString(),
        updated_at: new Date(Date.now()).toISOString(),
        html_url: `https://github.com/${REPOSITORY}/issues/${match[1]}#issuecomment-${id}`,
      })
      github.comments.set(id, comment)
      if (faults.loseCreateResponse?.(String(body.body))) {
        faults.loseCreateResponse = undefined
        throw new TypeError("Failed to fetch: the connection was reset")
      }
      return json(comment, 201, { "x-github-request-id": `req-${id}` })
    }
    if (method === "PATCH") {
      const match = new RegExp(`^${repo}/issues/comments/(\\d+)$`).exec(url.pathname)
      const current = match ? github.comments.get(Number(match[1])) : undefined
      if (!current) throw new Error(`Unexpected GitHub write ${method} ${url.pathname}`)
      const updated = { ...current, body: String(body.body) }
      github.comments.set(Number(match![1]), updated)
      return json(updated)
    }
    if (method !== "GET") throw new Error(`Unexpected GitHub method ${method}`)
    const response = await read(undefined, `${url.pathname}${url.search}`)
    return json(response.data, response.status, response.headers)
  })
}

/** What GitHub posts for a new issue comment. */
function issueCommentWebhook(comment: Record<string, unknown>, action = "created") {
  return {
    routeId: "route-1",
    deliveryId: `delivery-${String(comment.id)}-${action}`,
    eventType: "issue_comment",
    headers: {},
    receivedAt: new Date(Date.now()).toISOString(),
    body: JSON.stringify({
      action,
      repository: { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
      issue: {
        number: 7,
        title: "Crash on empty input",
        html_url: `https://github.com/${REPOSITORY}/issues/7`,
      },
      comment,
      sender: comment.user,
    }),
  }
}

interface Harness {
  github: FakeGithub
  requests: RecordedRequest[]
  faults: GithubFaults
  agent: jest.Mock
  acquire: jest.Mock
  snapshot: jest.Mock
  accountId: string
  installationId: string
  /** Drain until the Bot plane has nothing left to run. */
  settle: () => Promise<Array<{ status: string }>>
  /** One runner pass: only what was due when it started. */
  drainOnce: () => Promise<Array<{ status: string }>>
  registerHandler: () => void
  receive: (comment: Record<string, unknown>, action?: string) => Promise<unknown>
  dispose: () => void
}

interface HarnessOptions {
  publicationMode?: "automatic" | "approval"
  grant?: boolean
  /** When the installation was created; commands from before it are history. */
  installedAt?: number
  /** False installs the Bot before its plugin has registered the handler. */
  registerHandler?: boolean
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const github = fakeGithub()
  const requests: RecordedRequest[] = []
  const faults: GithubFaults = {}
  const fetch = githubFetch(github, requests, faults) as unknown as typeof globalThis.fetch
  const originalFetch = global.fetch
  global.fetch = fetch
  // The host installs these at boot; a person's approve and deny go through them.
  const controlHandlers = installExecutionRunControlHandlers()
  const secrets = new Map<string, string>()
  const disposeAuth = registerGithubIntegrationAuthProviders({
    store: {
      save: async (key, value) => void secrets.set(key, value),
      load: async (key) => secrets.get(key) ?? null,
      delete: async (key) => void secrets.delete(key),
    },
    fetch,
    now: () => Date.now(),
    createAppJwt: async () => "app-jwt",
    listAccountSessionIds: async () => [],
  })
  registerIntegrationDefinitions({
    pluginId: delivery.manifest.id,
    definitions: [delivery.githubIntegration],
    handlers: Object.fromEntries(
      delivery.githubIntegration.actions.map((action) => [
        `github:${action.id}`,
        delivery[action.handler as keyof typeof delivery],
      ])
    ) as never,
    normalizers: { github: delivery.normalizeGithub },
    resourceProviders: { github: delivery.listGithubResources },
    accountStatusProviders: { github: delivery.checkGithubHealth },
  })
  const session = await getSession(
    "github-pat",
    delivery.githubIntegration.authStrategies[0].scopes ?? [],
    {
      createIfNone: true,
      forceNewSession: true,
      configuration: { token: "pat-token", accountLabel: "cognia-bot" },
    }
  )
  const account = await createIntegrationAccount("github-delivery", {
    integrationId: "github",
    providerId: "github-pat",
    authSessionId: session!.id,
    remoteAccountId: "cognia-bot",
    label: "cognia-bot",
  })

  const agent = jest.fn(async () => ({
    sessionId: "session",
    agentId: "claude-code",
    status: "completed",
    text: JSON.stringify({ answer: "Empty input reaches `parse` unchecked." }),
    toolCalls: [],
  }))
  const acquire = jest.fn(async (spec: { ref: string }) => ({
    id: "workspace",
    root: "/tmp/workspace",
    headRef: spec.ref,
  }))
  const snapshot = jest.fn(async () => ({ id: "snapshot", files: [], diff: "" }))
  const storage = new Map<string, unknown>()
  const context = {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      delete: async (key: string) => void storage.delete(key),
    },
    bots: createBotsAPI(PLUGIN_ID, () => true),
    integrations: createIntegrationsAPI(PLUGIN_ID, () => true),
    workspace: { acquire, snapshot },
    agent: { runExternalAgent: agent },
    i18n: { t: translate },
  } as unknown as PluginContext
  const definition = githubCommentBotDef as unknown as PluginBotDef
  const register = (withHandler: boolean) =>
    registerBot(
      definition.id,
      {
        id: botDefinitionId(PLUGIN_ID, definition.id),
        definition,
        ...(withHandler ? { handler: createGithubCommentBot(context) } : {}),
      },
      { pluginId: PLUGIN_ID }
    )
  register(options.registerHandler !== false)
  const installation = await installBot({
    definitionId: botDefinitionId(PLUGIN_ID, definition.id),
    definitionSource: "plugin",
    pinnedVersion: definition.version,
    scope: { kind: "account" },
    config: {
      repository: REPOSITORY,
      trigger: TRIGGER,
      allowedAuthorIds: [String(AUTHOR.id)],
      publicationMode: options.publicationMode ?? "automatic",
    },
    credentialBindings: { github: { integrationAccountId: account.id } },
    requiredCredentials: definition.requires?.credentials,
    triggerOverrides: { github: true },
    ...(options.grant === false
      ? {}
      : { policyGrant: { maxAutonomy: "autopilot", requireApprovalForWrites: false } }),
    now: options.installedAt ?? Date.now() - 3_600_000,
  })

  const drainOnce = async () =>
    (await drainBotDeliveries({ owner: "host" })).map(
      (attempt) => attempt.outcome as { status: string }
    )
  // Both host loops, as the integration runtime and the Bot runner drive them
  // on Desktop and Headless alike: brokered write retries, then Bot deliveries.
  const settle = async () => {
    const outcomes: Array<{ status: string }> = []
    for (let pass = 0; pass < 10; pass++) {
      const jobs = await drainIntegrationActionJobs()
      const attempts = await drainBotDeliveries({ owner: "host" })
      if (!attempts.length && !jobs.length) return outcomes
      outcomes.push(...attempts.map((attempt) => attempt.outcome as { status: string }))
    }
    throw new Error("The Bot plane did not settle in ten passes")
  }
  const receive = (comment: Record<string, unknown>, action = "created") =>
    publishIntegrationEvent(
      "github-delivery",
      delivery.normalizeGithub(issueCommentWebhook(comment, action), {
        pluginId: "github-delivery",
        integrationId: "github",
        accountId: account.id,
      })
    )
  return {
    github,
    requests,
    faults,
    agent,
    acquire,
    snapshot,
    accountId: account.id,
    installationId: installation.id,
    settle,
    drainOnce,
    receive,
    registerHandler: () => register(true),
    dispose: () => {
      global.fetch = originalFetch
      disposeAuth()
      controlHandlers.dispose()
    },
  }
}

/** Every finished run's handler output, oldest first. */
async function results(): Promise<Array<Record<string, unknown>>> {
  const steps = await getDb().botRunSteps.toArray()
  return steps
    .filter((step) => step.name === "__host:result" && step.status === "completed")
    .map((step) => (step.output as { output?: Record<string, unknown> }).output ?? {})
}

const writes = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.method !== "GET")

/** Comments the Bot wrote (the fake numbers them from 7000). */
const botComments = (harness: Harness) =>
  [...harness.github.comments.values()]
    .filter((comment) => Number(comment.id) >= 7000)
    .map((comment) => String(comment.body))

const MINUTE = 60_000
const HOUR = 60 * MINUTE

let h: Harness | undefined

beforeEach(async () => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "nextTick",
      "queueMicrotask",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "hrtime",
      "performance",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
    ],
  })
  await getDb().delete()
  __resetDbForTesting()
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  __resetBotsForTesting()
  __resetLiveBotRunsForTesting()
}, 15_000)

afterEach(() => {
  h?.dispose()
  h = undefined
  jest.useRealTimers()
})

it("A2: answers an allowlisted question once, read-only, with a tracking comment to its end state", async () => {
  h = await harness()
  const command = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, command)

  await expect(h.receive(command)).resolves.toMatchObject({ inserted: true, botDeliveries: 1 })
  const outcomes = await h.settle()
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["completed", "completed"])

  // One model call, in a checkout of the default branch tip, told it is read-only.
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(h.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "bot-run", ref: "c".repeat(40), credentialSlot: "github" })
  )
  // Two comments (tracking, then the answer) and the tracking comment's edits.
  const posted = writes(h.requests)
  expect(posted.filter((request) => request.method === "POST")).toHaveLength(2)
  const bodies = [...h.github.comments.values()]
    .filter((comment) => comment.id !== 11)
    .map((comment) => String(comment.body))
  expect(bodies).toHaveLength(2)
  expect(bodies.every((body) => body.includes("<!-- cognia-command:v1:"))).toBe(true)
  expect(bodies.some((body) => body.includes("Empty input reaches `parse` unchecked."))).toBe(true)
  // Every write went through the bound account's token.
  expect(global.fetch).toHaveBeenCalled()
  const authorizations = (global.fetch as jest.Mock).mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => new Headers((init as RequestInit).headers).get("authorization"))
  expect(new Set(authorizations)).toEqual(new Set(["Bearer pat-token"]))

  // The tracking comment ends at its terminal state, pointing at the answer.
  const answer = [...h.github.comments.values()].find((comment) =>
    String(comment.body).includes("Empty input")
  )!
  expect(bodies.find((body) => body.includes("answered"))).toContain(String(answer.html_url))
  // The run detail carries the source, the commit and the published URL.
  expect(await results()).toContainEqual(
    expect.objectContaining({
      status: "completed",
      source: expect.objectContaining({ repository: REPOSITORY, kind: "issue_comment", id: "11" }),
      commitSha: "c".repeat(40),
      answerUrl: answer.html_url,
    })
  )
})

it("A1: ignores its own output, forged markers, quotes, code and plain comments without a model call or a write", async () => {
  h = await harness()
  const comments = [
    issueComment(20, "Answer\n\n<!-- cognia-command:v1:a-deadbeef-00000000 -->", {
      user: { id: 900, login: "cognia-bot[bot]", type: "Bot" },
    }),
    issueComment(21, `${TRIGGER} ask hi\n\n<!-- cognia-command:v1:a-deadbeef-00000000 -->`),
    issueComment(22, `> ${TRIGGER} ask why does it crash?\n\nSame question here.`),
    issueComment(23, `Try \`${TRIGGER} ask why\` to see it work.`),
    issueComment(24, "Looks good to me."),
  ]
  for (const comment of comments) {
    h.github.comments.set(Number(comment.id), comment)
    await h.receive(comment)
  }
  await h.settle()
  expect(h.agent).not.toHaveBeenCalled()
  expect(writes(h.requests)).toEqual([])
  expect(await getDb().botEventDeliveries.where("triggerId").equals("execute").count()).toBe(0)
})

it("A4: refuses an author off the allowlist or without write access, silently", async () => {
  h = await harness()
  h.github.permissions.set("stranger", { permission: "write", id: 77 })
  const stranger = issueComment(30, `${TRIGGER} ask why?`, {
    user: { id: 77, login: "stranger", type: "User" },
  })
  h.github.comments.set(30, stranger)
  await h.receive(stranger)
  h.github.permissions.set(AUTHOR.login, { permission: "read", id: AUTHOR.id })
  const reader = issueComment(31, `${TRIGGER} ask why?`)
  h.github.comments.set(31, reader)
  await h.receive(reader)
  await h.settle()
  expect(h.agent).not.toHaveBeenCalled()
  expect(writes(h.requests)).toEqual([])
})

it("A5: re-checks access when the answer starts and again before it is published", async () => {
  h = await harness()
  const first = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, first)
  await h.receive(first)
  await h.drainOnce() // receives and queues
  h.github.permissions.set(AUTHOR.login, { permission: "read", id: AUTHOR.id })
  await h.settle()
  expect(h.agent).not.toHaveBeenCalled()
  expect(writes(h.requests)).toEqual([])
  expect(await results()).toContainEqual(expect.objectContaining({ status: "denied" }))

  // Access lost while the agent was answering: nothing is published.
  h.github.permissions.set(AUTHOR.login, { permission: "write", id: AUTHOR.id })
  const second = issueComment(12, `${TRIGGER} ask and on null?`)
  h.github.comments.set(12, second)
  h.agent.mockImplementationOnce(async () => {
    h!.github.permissions.set(AUTHOR.login, { permission: "read", id: AUTHOR.id })
    return {
      sessionId: "session",
      agentId: "claude-code",
      status: "completed",
      text: JSON.stringify({ answer: "Null is handled." }),
      toolCalls: [],
    }
  })
  await h.receive(second)
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(botComments(h).some((body) => body.includes("Null is handled."))).toBe(false)
  expect(botComments(h)).toEqual([expect.stringContaining("cancelled")])
})

it("A6: an event that arrives before the plugin registered its handler is answered once, after recovery", async () => {
  h = await harness({ registerHandler: false })
  const command = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, command)
  await expect(h.receive(command)).resolves.toMatchObject({ inserted: true, botDeliveries: 0 })
  h.registerHandler()
  await expect(recoverIntegrationEventProjections({ now: Date.now() + HOUR })).resolves.toBe(1)
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  // GitHub redelivers the same webhook: a duplicate, not a second command.
  await expect(h.receive(command)).resolves.toMatchObject({ inserted: false, botDeliveries: 0 })
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(botComments(h).filter((body) => body.includes("Empty input"))).toHaveLength(1)
})

it("A8: a published answer whose response was lost is found again, not posted twice", async () => {
  h = await harness()
  const command = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, command)
  h.faults.loseCreateResponse = (body) => body.includes("Empty input")
  await h.receive(command)
  await h.settle()
  // The delivery retries after its backoff.
  jest.setSystemTime(Date.now() + HOUR)
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(botComments(h).filter((body) => body.includes("Empty input"))).toHaveLength(1)
  expect(await results()).toContainEqual(expect.objectContaining({ status: "completed" }))
  expect(botComments(h)).toContainEqual(expect.stringContaining("answered"))
})

it("A9: a deleted command is withdrawn and an edited one replaces its earlier version", async () => {
  h = await harness()
  const deleted = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, deleted)
  await h.receive(deleted)
  await h.drainOnce()
  h.github.comments.delete(11)
  await h.receive(deleted, "deleted")
  await h.settle()
  expect(h.agent).not.toHaveBeenCalled()
  expect(writes(h.requests)).toEqual([])

  const original = issueComment(12, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(12, original)
  await h.receive(original)
  await h.drainOnce()
  const edited = {
    ...original,
    body: `${TRIGGER} ask what happens with null?`,
    updated_at: new Date(Date.now()).toISOString(),
  }
  h.github.comments.set(12, edited)
  await h.receive(edited, "edited")
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(h.agent.mock.calls[0]).toEqual(
    expect.arrayContaining([expect.stringContaining("what happens with null?")])
  )
  expect(botComments(h).filter((body) => body.includes("Empty input"))).toHaveLength(1)
})

it("A14: a host that stops after the agent answered resumes without sending the prompt again", async () => {
  h = await harness()
  const command = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, command)
  h.snapshot.mockRejectedValueOnce(new Error("host stopped"))
  await h.receive(command)
  await h.settle()
  jest.setSystemTime(Date.now() + HOUR)
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(botComments(h).filter((body) => body.includes("Empty input"))).toHaveLength(1)
  expect(botComments(h)).toContainEqual(expect.stringContaining("answered"))
})

it("A20: a disabled installation starts nothing it had queued", async () => {
  h = await harness()
  const command = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, command)
  await h.receive(command)
  await h.drainOnce()
  await updateBotInstallation(h.installationId, { status: "disabled" })
  await h.settle()
  expect(h.agent).not.toHaveBeenCalled()
  expect(writes(h.requests)).toEqual([])
})

it("A22: a command older than its validity window is not run and gets the expired reply", async () => {
  h = await harness({ installedAt: NOW - 72 * HOUR })
  const stale = issueComment(11, `${TRIGGER} ask why does it crash?`, {
    created_at: new Date(NOW - 25 * HOUR).toISOString(),
    updated_at: new Date(NOW - 25 * HOUR).toISOString(),
  })
  h.github.comments.set(11, stale)
  await h.receive(stale)
  await h.settle()
  expect(h.agent).not.toHaveBeenCalled()
  expect(botComments(h)).toEqual([expect.stringContaining("older than 24 hours")])
})

it("A25: an agent that changed the checkout publishes nothing", async () => {
  h = await harness()
  const command = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, command)
  h.snapshot.mockResolvedValueOnce({
    id: "snapshot",
    files: [{ path: "src/parse.ts", oldContent: "a", newContent: "b" }],
    diff: "--- a/src/parse.ts\n+++ b/src/parse.ts\n",
  })
  await h.receive(command)
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(botComments(h)).toEqual([expect.stringContaining("tried to change files")])
  expect(await results()).toContainEqual(
    expect.objectContaining({ status: "blocked", reasonCode: "readonly_violation" })
  )
})

it("A26: approval mode posts no progress and publishes only after a person approves", async () => {
  h = await harness({ publicationMode: "approval" })
  const command = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, command)
  await h.receive(command)
  const outcomes = await h.settle()
  expect(outcomes.map((outcome) => outcome.status)).toContain("parked")
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(writes(h.requests)).toEqual([])

  const pending = await getDb()
    .executionRunInterrupts.filter((interrupt) => interrupt.status === "pending")
    .toArray()
  expect(pending).toHaveLength(1)
  await expect(
    respondRunApproval({
      interruptId: pending[0].id,
      decision: "approve",
      callerDeviceId: "desktop",
    })
  ).resolves.toEqual({ ok: true, status: "approved" })
  // The parked run re-checks its decision on the runner's next poll.
  jest.setSystemTime(Date.now() + MINUTE)
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(writes(h.requests).filter((request) => request.method === "POST")).toHaveLength(1)
  expect(botComments(h)).toEqual([expect.stringContaining("Empty input")])
})

it("A10: cancel is answered at once while an answer waits for its publication decision", async () => {
  h = await harness({ publicationMode: "approval" })
  const command = issueComment(11, `${TRIGGER} ask why does it crash?`)
  h.github.comments.set(11, command)
  await h.receive(command)
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  const waiting = await getDb()
    .executionRunInterrupts.filter((interrupt) => interrupt.status === "pending")
    .toArray()
  expect(waiting).toHaveLength(1)

  const cancel = issueComment(12, `${TRIGGER} cancel`, {
    created_at: new Date(Date.now()).toISOString(),
    updated_at: new Date(Date.now()).toISOString(),
  })
  h.github.comments.set(12, cancel)
  await h.receive(cancel)
  jest.setSystemTime(Date.now() + MINUTE)
  await h.settle()

  // The parked answer is withdrawn: its decision is no longer pending and it
  // never publishes, even if someone approves the stale request later.
  expect((await getDb().executionRunInterrupts.get(waiting[0].id))?.status).not.toBe("pending")
  await expect(
    respondRunApproval({
      interruptId: waiting[0].id,
      decision: "approve",
      callerDeviceId: "desktop",
    })
  ).resolves.toMatchObject({ ok: false })
  jest.setSystemTime(Date.now() + MINUTE)
  await h.settle()
  expect(h.agent).toHaveBeenCalledTimes(1)
  expect(botComments(h).some((body) => body.includes("Empty input"))).toBe(false)
  // The cancel reply itself waits for a person, as every reply does in this mode.
  const replies = await getDb()
    .executionRunInterrupts.filter((interrupt) => interrupt.status === "pending")
    .toArray()
  expect(replies).toHaveLength(1)
})
