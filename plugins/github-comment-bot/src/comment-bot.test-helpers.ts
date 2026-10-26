/**
 * Shared fixtures for the Comment Bot suites: an in-memory plugin context, a
 * Bot run with the host's memo semantics, and GitHub reads answered from a
 * mutable fake repository. Test-only; never imported by the plugin entry.
 */
import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import {
  AUTHOR,
  fakeGithub,
  HEAD,
  memoizedStep,
  memoryStorage,
  NOW,
  REPOSITORY,
  routeFake,
} from "@cognia/github-bot-kit/testing"

import manifestJson from "../plugin.json"
import { parseConfig } from "./config"

export {
  AUTHOR,
  BOT,
  HEAD,
  NOW,
  REPOSITORY,
  REPOSITORY_ID,
  fakeGithub,
  issueComment,
  routeFake,
  type FakeGithub,
} from "@cognia/github-bot-kit/testing"

export const TRIGGER = "@cognia-bot"

const EN: Record<string, string> = manifestJson.i18n.locales.en

/** `ctx.i18n.t` over the plugin's own en bundle, as the host resolves it. */
export function translate(key: string, params?: Record<string, string | number>): string {
  const template = EN[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** What a brokered write carried; the fields the suites read are named. */
export interface RecordedWriteInput {
  body?: string
  marker?: string
  since?: string
  [key: string]: unknown
}

const QUEUED_TRIGGERS = new Set(["execute", "reply"])

export function fixture(
  options: {
    triggerId?: string
    payload?: unknown
    source?: BotRunContextV1["event"]["source"]
    type?: string
    config?: Record<string, unknown>
    now?: number
    /** Defaults to how the host marks it: queued work is the Bot's own, everything else is not. */
    selfProduced?: boolean
  } = {}
) {
  const github = fakeGithub()
  const storage = memoryStorage()
  const step = memoizedStep()
  const request = jest.fn(routeFake(github))
  const deliveries: Array<{
    id: string
    eventId: string
    triggerId: string
    type: string
    status: string
    runId?: string
    resource?: { kind: string; id: string; scope?: string }
    receivedAt: number
    attempts: number
    payload?: unknown
  }> = []
  const runResults = new Map<string, unknown>()
  let jobs = 0
  const mocks = {
    request,
    enqueue: jest.fn(
      async (
        _runId: string,
        input: {
          triggerId: string
          eventId: string
          type: string
          payload: unknown
          resource?: { kind: string; id: string; scope?: string }
        }
      ) => {
        const existing = deliveries.find((row) => row.eventId === input.eventId)
        if (existing) return { deliveryId: existing.id }
        const id = `delivery-${deliveries.length + 1}`
        deliveries.unshift({
          id,
          eventId: input.eventId,
          triggerId: input.triggerId,
          type: input.type,
          status: "pending",
          resource: input.resource,
          receivedAt: NOW + deliveries.length,
          attempts: 0,
          payload: input.payload,
        })
        return { deliveryId: id }
      }
    ),
    cancelResource: jest.fn(
      async (_runId: string, input: { resourceId: string; exceptRevision?: string }) => {
        let count = 0
        for (const row of deliveries) {
          if (
            row.resource?.id === input.resourceId &&
            ["pending", "leased", "running", "parked"].includes(row.status) &&
            (!input.exceptRevision ||
              (row.payload as { revision?: string } | undefined)?.revision !== input.exceptRevision)
          ) {
            row.status = "dismissed"
            count += 1
          }
        }
        return count
      }
    ),
    listDeliveries: jest.fn(
      async (
        _runId: string,
        query?: { triggerId?: string; status?: string[]; limit?: number; resourceId?: string }
      ) =>
        deliveries
          .filter(
            (row) =>
              (!query?.triggerId || row.triggerId === query.triggerId) &&
              (!query?.status || query.status.includes(row.status)) &&
              (!query?.resourceId || row.resource?.id === query.resourceId)
          )
          .slice(0, query?.limit ?? 50)
          .map(({ payload: _payload, ...summary }) => summary)
    ),
    getRunResult: jest.fn(async (_runId: string, input: { runId: string }) =>
      runResults.has(input.runId)
        ? { status: "succeeded", output: runResults.get(input.runId) }
        : null
    ),
    recordMonitor: jest.fn(async () => undefined),
    health: jest.fn(async (_binding: unknown) => ({
      health: "healthy",
      checkedAt: new Date(NOW).toISOString(),
    })),
    getInstallation: jest.fn(async () => ({
      id: "install",
      createdAt: NOW - 86_400_000,
      activatedAt: NOW - 3_600_000,
      webhookEnabled: false,
      config: {},
      triggerState: {},
      triggers: [
        { id: "github", kind: "event", armed: false },
        { id: "poll", kind: "poll", armed: true },
      ],
      readiness: { policyDecisions: true, executionRoute: "gateway" },
    })),
    // The host checks out an exact SHA as itself, and a pull ref at the PR's head.
    acquire: jest.fn(async (spec: { ref: string }) => ({
      id: "workspace",
      runId: "run",
      root: "/isolated",
      origin: "bot-run",
      headRef: /^[0-9a-f]{40}$/.test(spec.ref) ? spec.ref : HEAD,
    })),
    snapshot: jest.fn(async () => ({
      id: "snapshot",
      runId: "run",
      baseSha: HEAD,
      headSha: HEAD,
      diff: "",
      files: [],
      capturedAt: NOW,
    })),
    agent: jest.fn(async (_preset: string, _prompt: string, _options: Record<string, unknown>) => ({
      sessionId: "session",
      agentId: "claude-code",
      status: "completed",
      text: JSON.stringify({ answer: "Empty input reaches `parse` unchecked." }),
      toolCalls: [],
    })),
    action: jest.fn(async (input: { actionId: string; input: RecordedWriteInput }) => {
      jobs += 1
      return {
        id: `job-${jobs}`,
        status: "succeeded",
        output: {
          id: 5000 + jobs,
          html_url: `https://github.com/${REPOSITORY}/issues/7#issuecomment-${5000 + jobs}`,
          action: input.actionId,
        },
      }
    }),
    approval: jest.fn(
      async (
        _name: string,
        _request: { decisionMode?: string; [key: string]: unknown }
      ): Promise<{ outcome: string; decidedAt: number; approvalId?: string }> => ({
        outcome: "approved",
        decidedAt: NOW,
        approvalId: "approval",
      })
    ),
  }
  const context = {
    pluginId: "github-comment-bot",
    storage: { get: storage.get, set: storage.set },
    bots: {
      enqueue: mocks.enqueue,
      cancelResource: mocks.cancelResource,
      listDeliveries: mocks.listDeliveries,
      getRunResult: mocks.getRunResult,
      recordMonitor: mocks.recordMonitor,
      getInstallation: mocks.getInstallation,
    },
    integrations: {
      authenticatedRequest: request,
      executeAction: mocks.action,
      checkAccountHealth: mocks.health,
    },
    workspace: { acquire: mocks.acquire, snapshot: mocks.snapshot },
    agent: { runExternalAgent: mocks.agent },
    i18n: { t: jest.fn(translate) },
  } as unknown as PluginContext
  const config = {
    repository: REPOSITORY,
    allowedAuthorIds: [String(AUTHOR.id)],
    ...options.config,
  }
  const run: BotRunContextV1 = {
    runId: "run",
    installationId: "install",
    botId: "github-comment-bot:comment-commands",
    config,
    signal: new AbortController().signal,
    event: {
      eventId: "event",
      deliveryId: "delivery",
      source: options.source ?? "manual",
      type: options.type ?? "github-command.execute",
      installationId: "install",
      triggerId: options.triggerId ?? "execute",
      occurredAt: NOW,
      receivedAt: NOW,
      payload: options.payload ?? {},
      provenance: QUEUED_TRIGGERS.has(options.triggerId ?? "execute")
        ? (options.selfProduced ?? true)
          ? { selfProduced: true, depth: 1, producedByInstallationId: "install" }
          : { selfProduced: false, depth: 0 }
        : { selfProduced: options.selfProduced ?? false, depth: 0 },
    } as BotRunContextV1["event"],
    step: {
      run: step.run as BotRunContextV1["step"]["run"],
      waitForApproval: mocks.approval as never,
      waitForEvent: jest.fn(),
    },
    log: jest.fn(),
    progress: jest.fn(),
  }
  /** The brokered writes, in order. */
  const writes = () =>
    mocks.action.mock.calls.map(([call]) => call as { actionId: string; input: RecordedWriteInput })
  /** The body of the `index`th brokered write. */
  const bodyOf = (index: number) => String(writes()[index]?.input.body ?? "")
  return {
    github,
    context,
    run,
    writes,
    bodyOf,
    // A setup-error fixture has no parsed config; its tests go through the handler.
    config: (() => {
      try {
        return parseConfig(config)
      } catch {
        return undefined as unknown as ReturnType<typeof parseConfig>
      }
    })(),
    mocks,
    storage,
    step,
    deliveries,
    runResults,
    now: () => options.now ?? NOW,
  }
}
