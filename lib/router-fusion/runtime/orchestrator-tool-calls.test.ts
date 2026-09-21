/** @jest-environment jsdom */
/**
 * A panel run, end to end through the orchestrator, against the AI SDK's own
 * mock model (ADR-0188 B3, D26).
 *
 * The rest of the B3 tests drive `executeFusionRun` with the Fake Provider,
 * which answers a `RoleCallRequest` directly. That leaves the real seam
 * untested: `calls/role-call-executor.ts` has to offer the step's tools to the
 * AI SDK and hand the model's requests back, or an evidence panel can never
 * read anything and ends `degraded` with a real provider. Here the request
 * really goes through `generateText`, the model really asks for a tool, the
 * run's own `ToolRuntime` really executes it, and the panel reaches `accepted`.
 *
 * The second case is the recovery half of the same seam: a worker that dies in
 * the middle of a tool round must replay the committed tool requests instead of
 * calling the provider again (REC-03).
 */

import "fake-indexeddb/auto"

import type { AppSettings } from "@cognia/agent-config-types"
import {
  fakeCompiledConfig,
  fakeTierRegistry,
  fixtureRouteRequest,
  routeAction,
  type FusionRegistry,
  type ToolContext,
  type ToolIntent,
  type ToolReceipt,
  type ToolRuntime,
} from "@cognia/router-fusion"
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider"
import { MockLanguageModelV4 } from "ai/test"

const resolveDeploymentLlmConfigMock = jest.fn(
  (..._args: unknown[]) =>
    ({ provider: "openai", model: "gpt-5-mini", apiKey: "sk-test" }) as unknown
)
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  resolveDeploymentLlmConfig: (...args: unknown[]) => resolveDeploymentLlmConfigMock(...args),
}))

import { createRoleCallExecutor } from "../calls/role-call-executor"
import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore, type CreateRunInput } from "../db/ledger-store"
import type { OutboxAppliers } from "../db/outbox"
import { encodeRunInput } from "../db/run-input"
import { RouterFusionInfrastructureError } from "../gate/faults"
import {
  createHostToolRuntime,
  PANEL_READ_POLICY,
  PANEL_VERIFY_POLICY,
} from "../tools/tool-runtime"
import type { WebEvidence } from "../tools/web-evidence"
import { executeFusionRun } from "./orchestrator-host"

const USD = 1_000_000
const PAGE = "The 2025 steel tariff is 4%, up from 2% in 2024."
const TARIFF_URL = "https://example.com/tariffs"

/**
 * The fake registry with host-shaped deployment ids (`providerId::modelId`),
 * because the real executor resolves the pinned deployment's credentials from
 * exactly that id.
 */
function hostShapedRegistry(): FusionRegistry {
  const base = fakeTierRegistry()
  const rename = (id: string) => `fake::${id.replace(/^fake-/, "")}`
  return {
    ...base,
    deployments: base.deployments.map((deployment) => ({
      ...deployment,
      id: rename(deployment.id),
    })),
    aliases: Object.fromEntries(
      Object.entries(base.aliases).map(([alias, ids]) => [alias, ids.map(rename)])
    ),
  }
}

const config = fakeCompiledConfig({ registry: hostShapedRegistry() })
let dbCounter = 0

const appliers: OutboxAppliers = {
  usage_row: jest.fn(async () => "applied" as const),
  execution_run_milestone: jest.fn(async () => "applied" as const),
  execution_run_projection: jest.fn(async () => "applied" as const),
  session_message: jest.fn(async () => "applied" as const),
}

function harness() {
  const name = `fusion-tool-call-test-${++dbCounter}`
  const db = new FusionDB(name)
  const store = new FusionLedgerStore({ db, codec: fusionContentCodec(name) })
  return { db, store }
}

function panelRunInput(runId: string): CreateRunInput {
  const { decision } = routeAction(
    config,
    fixtureRouteRequest({ runId, decisionId: `decision-${runId}` })
  )
  return {
    runId,
    sessionId: null,
    surface: "gatewayRuns",
    origin: "gateway",
    decision,
    actionId: "panel_review",
    ruleId: null,
    roleDeployments: {
      panel_a: "fake::economy",
      panel_b: "fake::independent",
      judge: "fake::baseline",
      synthesizer: "fake::baseline",
    },
    config,
    capMicrousd: 2 * USD,
    maxModelCalls: 24,
    deadlineMs: 600_000,
    budgetMode: "tracked",
    tenantLimitRemainingMicrousd: null,
    acceptanceProfile: "evidence_review",
    task: "research.synthesis",
  }
}

async function storeInput(store: FusionLedgerStore, runId: string, content: string) {
  const stored = await store.artifactStore(runId).put(
    encodeRunInput({
      messages: [{ role: "user", content }],
      allowDegraded: false,
      jsonSchema: null,
    }),
    "application/json",
    `runs/${runId}/input`
  )
  await store.db.fusionRuns.update(runId, { inputArtifactId: stored.artifactId })
}

function fakeWeb(pages: Record<string, string>): WebEvidence {
  return {
    async fetchPage(url) {
      const content = pages[url]
      return content === undefined
        ? { ok: false, code: "HTTP_ERROR", message: "404", audit: [] }
        : { ok: true, finalUrl: url, title: "page", content, truncated: false }
    },
  }
}

type ModelCall = LanguageModelV4CallOptions

/** Everything the model was shown, as one string. */
function promptText(prompt: ModelCall["prompt"]): string {
  return (prompt as Array<{ role: string; content: unknown }>)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<Record<string, unknown>>)
            .map((part) => (typeof part.text === "string" ? part.text : JSON.stringify(part)))
            .join("\n")
    )
    .join("\n")
}

/** The JSON document the step asked for, which is the first system turn. */
function schemaAsk(prompt: ModelCall["prompt"]): string {
  const first = prompt[0]
  return first?.role === "system" ? first.content : ""
}

function jsonReply(value: unknown, id: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 400, noCache: 400, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 80, text: 80, reasoning: undefined },
    },
    warnings: [],
    response: { id },
  }
}

/** The evidence references a tool round handed the candidate back. */
function evidenceRefs(text: string): unknown[] {
  return [...text.matchAll(/evidence: (\{[^\n]*\})/g)].map(
    (match) => JSON.parse(match[1]) as unknown
  )
}

/**
 * One model that plays every role of the panel. It answers the schema each
 * step asked for, and asks for `web_fetch` whenever a step actually offers it —
 * which is the whole point: with tools missing from the request there is
 * nothing to ask with.
 */
function panelModel() {
  const toolOffers: string[][] = []
  let toolAsks = 0
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const offered = (options.tools ?? []).map((entry) => entry.name)
      const shown = promptText(options.prompt)
      const ask = schemaAsk(options.prompt)
      if (offered.length > 0) {
        toolOffers.push(offered)
        toolAsks++
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call_${toolAsks}`,
              toolName: "web_fetch",
              input: JSON.stringify({ url: TARIFF_URL }),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
          usage: {
            inputTokens: { total: 300, noCache: 300, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 20, reasoning: undefined },
          },
          warnings: [],
          response: { id: `resp_tool_${toolAsks}` },
        }
      }
      if (ask.includes("new_unsupported_claims")) {
        return jsonReply(
          {
            status: "passed",
            new_unsupported_claims: [],
            missing_requirements: [],
            lost_citations: [],
          },
          "resp_final_check"
        )
      }
      if (ask.includes("used_claim_ids")) {
        const artifactId = /"artifact_id":\s*"([^"]+)"/.exec(shown)?.[1] ?? "none"
        return jsonReply(
          {
            answer: "The 2025 steel tariff is 4%.",
            used_claim_ids: ["A.c1"],
            uncertainties: [],
            citations: [{ claim_id: "A.c1", artifact_id: artifactId }],
          },
          "resp_synthesis"
        )
      }
      if (ask.includes("ready_to_synthesize")) {
        return jsonReply(
          {
            supported_claim_ids: ["A.c1", "B.c1"],
            rejected_claim_ids: [],
            contradictions: [],
            missing_requirements: [],
            verification_requests: [],
            ready_to_synthesize: true,
          },
          "resp_judge"
        )
      }
      return jsonReply(
        {
          answer: "The 2025 steel tariff is 4%.",
          claims: [
            {
              claim_id: "c1",
              text: "the 2025 steel tariff is 4%",
              evidence_refs: evidenceRefs(shown),
            },
          ],
          assumptions: [],
          open_questions: [],
        },
        "resp_candidate"
      )
    },
  })
  return {
    languageModel: async () => model,
    toolOffers,
    get toolAsks() {
      return toolAsks
    },
  }
}

function deps(store: FusionLedgerStore, overrides: Record<string, unknown> = {}) {
  return {
    store: async () => store,
    appliers,
    leaseOwner: "worker:test",
    appSettings: () => ({}) as AppSettings,
    sleep: async () => {},
    heartbeatMs: 1_000_000,
    ...overrides,
  }
}

beforeEach(() => {
  resolveDeploymentLlmConfigMock.mockClear()
  resolveDeploymentLlmConfigMock.mockReturnValue({
    provider: "openai",
    model: "gpt-5-mini",
    apiKey: "sk-test",
  })
})

describe("executeFusionRun with a real AI SDK role call", () => {
  it("[ACC:PAN-04] a panel candidate calls its evidence tool through the SDK and the panel is accepted", async () => {
    const { db, store } = harness()
    await store.createRun(panelRunInput("run-sdk-panel"))
    await storeInput(store, "run-sdk-panel", "What is the 2025 steel tariff? Cite a source.")
    const model = panelModel()
    const executor = createRoleCallExecutor({
      appSettings: {} as AppSettings,
      languageModel: model.languageModel,
    })
    const tools = async (toolStore: FusionLedgerStore, run: { runId: string }) => ({
      runtime: createHostToolRuntime({
        store: toolStore,
        runId: run.runId,
        web: fakeWeb({ [TARIFF_URL]: PAGE }),
        workspace: null,
        now: () => Date.now(),
      }),
      memberPolicyId: PANEL_READ_POLICY,
      verificationPolicyId: PANEL_VERIFY_POLICY,
    })

    const outcome = await executeFusionRun(deps(store, { executor, tools }), {
      runId: "run-sdk-panel",
    })
    if (outcome.kind !== "succeeded") throw new Error(JSON.stringify(outcome))
    expect(outcome.result).toMatchObject({
      mode_executed: "panel",
      quality_status: "accepted",
      answer: "The 2025 steel tariff is 4%.",
    })

    // The tools reached the model with their schemas, once per candidate.
    expect(model.toolOffers).toEqual([["web_fetch"], ["web_fetch"]])
    // And the runtime — not the SDK — executed them, recording one operation
    // each, with the page stored as this run's own evidence.
    const operations = await db.fusionToolOperations.toArray()
    expect(operations.map((row) => [row.toolName, row.status])).toEqual([
      ["web_fetch", "succeeded"],
      ["web_fetch", "succeeded"],
    ])
    const [cited] = operations[0].evidence
    expect((await store.artifactStore("run-sdk-panel").get(cited.artifact_id))?.content).toBe(PAGE)
    expect((await store.getRun("run-sdk-panel"))?.status).toBe("succeeded")
  })

  it("[ACC:REC-03] a run resumed mid tool round replays its tool requests instead of paying again", async () => {
    const { db, store } = harness()
    await store.createRun(panelRunInput("run-sdk-resume"))
    await storeInput(store, "run-sdk-resume", "What is the 2025 steel tariff? Cite a source.")
    const model = panelModel()
    const executor = createRoleCallExecutor({
      appSettings: {} as AppSettings,
      languageModel: model.languageModel,
    })
    const liveRuntime = (toolStore: FusionLedgerStore, runId: string): ToolRuntime =>
      createHostToolRuntime({
        store: toolStore,
        runId,
        web: fakeWeb({ [TARIFF_URL]: PAGE }),
        workspace: null,
        now: () => Date.now(),
      })

    // The worker dies once both candidates have their tool requests committed
    // and neither has been executed: exactly the window a crash leaves behind.
    let entered = 0
    let bothIn: () => void = () => {}
    const bothEntered = new Promise<void>((resolve) => (bothIn = resolve))
    const crashingTools = async (toolStore: FusionLedgerStore, run: { runId: string }) => ({
      runtime: {
        describe: (policyId: string) => liveRuntime(toolStore, run.runId).describe(policyId),
        async execute(_intent: ToolIntent, _context: ToolContext): Promise<ToolReceipt> {
          entered++
          if (entered >= 2) bothIn()
          await bothEntered
          throw new RouterFusionInfrastructureError("internal", "the worker went away")
        },
      },
      memberPolicyId: PANEL_READ_POLICY,
      verificationPolicyId: PANEL_VERIFY_POLICY,
    })

    await expect(
      executeFusionRun(
        deps(store, {
          executor,
          tools: crashingTools,
          leaseOwner: "worker:crashed",
          leaseMs: 1,
          heartbeatMs: 1_000_000,
        }),
        { runId: "run-sdk-resume" }
      )
    ).rejects.toBeInstanceOf(RouterFusionInfrastructureError)
    // The crash sealed nothing: the run is still the one the ledger holds.
    expect((await store.getRun("run-sdk-resume"))?.status).toBe("running")
    const askedBeforeCrash = model.toolAsks
    expect(askedBeforeCrash).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 5))

    const tools = async (toolStore: FusionLedgerStore, run: { runId: string }) => ({
      runtime: liveRuntime(toolStore, run.runId),
      memberPolicyId: PANEL_READ_POLICY,
      verificationPolicyId: PANEL_VERIFY_POLICY,
    })
    const outcome = await executeFusionRun(
      deps(store, { executor, tools, leaseOwner: "worker:resumed" }),
      { runId: "run-sdk-resume" }
    )
    if (outcome.kind !== "succeeded") throw new Error(JSON.stringify(outcome))
    expect(outcome.result).toMatchObject({ mode_executed: "panel", quality_status: "accepted" })
    // The replayed steps asked the provider for nothing: the committed tool
    // requests came back from the ledger, and the runtime executed them.
    expect(model.toolAsks).toBe(askedBeforeCrash)
    const firstCalls = await db.fusionCallAttempts
      .where("[runId+logicalStepId]")
      .equals(["run-sdk-resume", "panel:member:panel_a:1"])
      .toArray()
    expect(firstCalls.map((attempt) => attempt.state)).toEqual(["SUCCEEDED"])
    expect((await db.fusionToolOperations.toArray()).map((row) => row.toolName)).toEqual([
      "web_fetch",
      "web_fetch",
    ])
  })
})
