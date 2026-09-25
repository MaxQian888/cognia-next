/**
 * Shared fixtures for the Devin Bot suites: an in-memory plugin context and a
 * Bot run whose GitHub reads are answered from canned data. Test-only; never
 * imported by the plugin entry.
 */
import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import { parseConfig } from "./config"
import type { Item, Work } from "./github"
import manifestJson from "../plugin.json"

/** A placeholder repository; the plugin itself ships no default. */
export const TEST_REPOSITORY = "acme/widgets"
const DEFAULT_REPOSITORY = TEST_REPOSITORY

const EN_MESSAGES: Record<string, string> = manifestJson.i18n.locales.en

/** `ctx.i18n.t` over the plugin's own en bundle, as the host resolves it. */
export function translate(key: string, params?: Record<string, string | number>): string {
  const template = EN_MESSAGES[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

export const NOW = Date.parse("2026-09-12T10:00:00Z")
export const SHA = "a".repeat(40)
export const issue: Item = {
  number: 7,
  title: "Fix validation",
  body: "Empty input should fail",
  state: "open",
  created_at: new Date(NOW).toISOString(),
  updated_at: new Date(NOW).toISOString(),
}
export const pr: Item = {
  ...issue,
  number: 8,
  head: { sha: SHA, ref: "feature", repo: { full_name: DEFAULT_REPOSITORY } },
  base: { sha: "b".repeat(40), ref: "master", repo: { full_name: DEFAULT_REPOSITORY } },
}

export function fixture(mode: Work["mode"] = "implement") {
  const memory = new Map<string, unknown>()
  const memo = new Map<string, unknown>()
  const item = mode === "implement" ? { ...issue } : structuredClone(pr)
  const work: Work = {
    repository: DEFAULT_REPOSITORY,
    number: item.number,
    kind: mode === "implement" ? "issue" : "pr",
    mode,
    revision: mode === "implement" ? item.created_at : SHA,
  }
  const report = {
    summary: "Fixed validation",
    review: "Handle empty input before parsing.",
    changesNeeded: true,
    tests: [{ command: "pnpm test", exitCode: 0, output: "PASS validation" }],
  }
  const snapshot = {
    id: "snapshot",
    runId: "run",
    baseSha: SHA,
    headSha: SHA,
    diff: mode === "review" ? "" : "+validate(input)",
    files: [],
    capturedAt: NOW,
  }
  const request = jest.fn(async (_binding: unknown, url: string) => {
    const path = url.replace(`https://api.github.com/repos/${DEFAULT_REPOSITORY}`, "")
    let data: unknown
    if (path === "") data = { default_branch: "master" }
    else if (path.startsWith("/compare/"))
      data = {
        status: "ahead",
        merge_base_commit: { sha: path.slice("/compare/".length).split("...")[0] },
      }
    else if (path.includes("/check-runs")) data = { check_runs: [] }
    else if (path.startsWith("/commits/")) data = { sha: SHA }
    else if (path === `/issues/${item.number}` || path === `/pulls/${item.number}`)
      data = structuredClone(item)
    else if (path.includes("/reviews")) data = []
    else if (path.startsWith("/actions/runs?"))
      data = {
        workflow_runs:
          mode === "repair"
            ? [{ id: 22, head_sha: SHA, conclusion: "failure", status: "completed" }]
            : [],
      }
    else if (path.startsWith("/actions/runs/22/jobs"))
      data = { jobs: [{ id: 44, conclusion: "failure", name: "test", steps: [] }] }
    else if (path === "/actions/jobs/44/logs") data = "FAIL validation"
    else if (path.includes("head=")) data = []
    else if (path.startsWith("/issues?")) data = [structuredClone(item)]
    else if (path.startsWith("/pulls?")) data = mode === "implement" ? [] : [structuredClone(item)]
    else throw new Error(`Unexpected fixture URL ${url}`)
    return { status: 200, headers: {} as Record<string, string>, data }
  })
  const mocks = {
    request,
    enqueue: jest.fn(async () => ({ deliveryId: "child" })),
    cancelResource: jest.fn(async () => 1),
    recordMonitor: jest.fn(async () => undefined),
    getInstallation: jest.fn(async () => ({
      id: "install",
      createdAt: NOW - 1000,
      activatedAt: NOW - 1000,
      webhookEnabled: false,
      config: {},
      triggerState: {},
    })),
    acquire: jest.fn(async () => ({
      id: "workspace",
      runId: "run",
      rootPath: "/isolated",
      origin: "bot-run",
    })),
    snapshot: jest.fn(async () => snapshot),
    publish: jest.fn(async () => ({ branch: "branch", headSha: SHA })),
    agent: jest.fn(async () => ({
      sessionId: "session",
      agentId: "devin",
      model: "swe-2-medium",
      status: "completed",
      text: JSON.stringify(report),
      toolCalls: [],
    })),
    action: jest.fn(async (input: { input: Record<string, unknown> }) => {
      if (mode !== "review")
        request.mockImplementation(async (_binding, url) => {
          if (url.includes("head="))
            return {
              status: 200,
              headers: {},
              data: [
                {
                  number: 42,
                  body: input.input.body,
                  head: { ref: input.input.head, sha: SHA },
                  base: { ref: input.input.base },
                },
              ],
            }
          if (url.includes("/commits/")) return { status: 200, headers: {}, data: { sha: SHA } }
          return { status: 200, headers: {}, data: item }
        })
      return { id: "job", status: "succeeded", output: { number: 42 } }
    }),
    approval: jest.fn(async () => ({
      outcome: "approved",
      decidedAt: NOW,
      approvalId: "approval",
    })),
  }
  const context = {
    pluginId: "github-devin-bot",
    storage: {
      get: async (key: string) => memory.get(key),
      set: async (key: string, value: unknown) => {
        memory.set(key, value)
      },
    },
    bots: {
      enqueue: mocks.enqueue,
      cancelResource: mocks.cancelResource,
      recordMonitor: mocks.recordMonitor,
      getInstallation: mocks.getInstallation,
    },
    integrations: { authenticatedRequest: request, executeAction: mocks.action },
    workspace: { acquire: mocks.acquire, snapshot: mocks.snapshot, publish: mocks.publish },
    agent: { runExternalAgent: mocks.agent },
    i18n: { t: jest.fn(translate) },
  } as unknown as PluginContext
  const run: BotRunContextV1 = {
    runId: "run",
    installationId: "install",
    botId: "github-devin-bot:repository-monitor",
    config: { repository: TEST_REPOSITORY },
    signal: new AbortController().signal,
    event: {
      eventId: "event",
      deliveryId: "delivery",
      source: "manual",
      type: "github-devin.work",
      installationId: "install",
      triggerId: "work",
      occurredAt: NOW,
      receivedAt: NOW,
      payload: work,
      provenance: { selfProduced: false, depth: 0 },
    },
    step: {
      run: async (name, fn) => {
        if (memo.has(name)) return memo.get(name) as never
        const result = await fn()
        memo.set(name, structuredClone(result))
        return result
      },
      waitForApproval: mocks.approval as never,
      waitForEvent: jest.fn(),
    },
    log: jest.fn(),
    progress: jest.fn(),
  }
  return {
    context,
    run,
    config: parseConfig({ repository: TEST_REPOSITORY }),
    mocks,
    memory,
    memo,
    item,
    snapshot,
    report,
    work,
  }
}
