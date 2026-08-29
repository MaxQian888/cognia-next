/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { resolveStepRetryPolicy, runStep, type RunStepInput } from "./step-executor"
import { registerNodeExecutor } from "@/lib/workflow/nodes/registry"
import { IdempotencyCache } from "./idempotency"
import { createRunLogger, listRunEvents } from "./event-log"
import { NoopSecretResolver } from "./secret-resolver"
import { CircuitOpenError, resetCircuitBreaker } from "./circuit-breaker"
import { addPluginCatalogEntry, __resetPluginCatalogForTesting } from "@/lib/workflow/nodes/catalog"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type StepExecutionContext,
  type TriggerEvent,
  type VisualWorkflow,
  type WorkflowNode,
} from "@/types/workflow/visual"

const execSpy = jest.fn(async (_ctx: StepExecutionContext) => ({ output: { real: true } }))

// Register once for this isolated module registry. Cast because the test kind
// reuses a real union member but supplies its own spy executor.
registerNodeExecutor({ kind: "data.code", typeVersion: 1, execute: execSpy })

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  execSpy.mockClear()
  resetCircuitBreaker()
  __resetPluginCatalogForTesting()
}, 15_000)

const node: WorkflowNode = {
  id: "n1",
  type: "data.code",
  typeVersion: 1,
  position: { x: 0, y: 0 },
  data: { label: "n1", params: { code: "return null" } },
}

function makeWorkflow(pinData?: Record<string, unknown>): VisualWorkflow {
  return {
    id: "wf",
    schemaVersion: 1,
    name: "t",
    createdAt: 0,
    updatedAt: 0,
    nodes: [node],
    edges: [],
    settings: DEFAULT_WORKFLOW_SETTINGS,
    ...(pinData ? { pinData } : {}),
  }
}

const trigger: TriggerEvent = { workflowId: "wf", kind: "trigger.manual", payload: {}, originAt: 0 }

async function buildInput(opts: {
  honorPinData?: boolean
  pinData?: Record<string, unknown>
  iterationMeta?: { loopId: string; iterationIndex: number }
  executionBinding?: RunStepInput["executionBinding"]
  traceId?: string
  lineage?: RunStepInput["lineage"]
  securityContext?: RunStepInput["securityContext"]
}): Promise<RunStepInput> {
  const runId = "run_1"
  return {
    workflow: makeWorkflow(opts.pinData),
    node,
    trigger,
    upstream: {},
    runId,
    signal: new AbortController().signal,
    cache: await IdempotencyCache.hydrate(runId),
    retryPolicy: DEFAULT_WORKFLOW_SETTINGS.retryDefaults,
    secretResolver: NoopSecretResolver,
    logger: createRunLogger(runId),
    honorPinData: opts.honorPinData,
    iterationMeta: opts.iterationMeta,
    executionBinding: opts.executionBinding,
    traceId: opts.traceId,
    lineage: opts.lineage,
    securityContext: opts.securityContext,
  }
}

describe("runStep pin short-circuit", () => {
  it("returns the pinned value WITHOUT invoking the executor when honorPinData is true", async () => {
    const input = await buildInput({ honorPinData: true, pinData: { n1: { pinned: 1 } } })
    const result = await runStep(input)

    expect(execSpy).not.toHaveBeenCalled()
    expect(result.output).toEqual({ pinned: 1 })
    expect(result.fromCache).toBe(false)
    expect(input.cache.get("n1")).toEqual({ pinned: 1 })

    const events = await listRunEvents("run_1")
    expect(events.find((e) => e.type === "step_started")).toBeDefined()
    const completed = events.find((e) => e.type === "step_completed")
    expect((completed?.payload as { output?: unknown })?.output).toEqual({ pinned: 1 })
  })

  it("ignores pin data when honorPinData is falsy (production-style run)", async () => {
    const input = await buildInput({ pinData: { n1: { pinned: 1 } } })
    const result = await runStep(input)

    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(result.output).toEqual({ real: true })
  })

  it("runs the executor when honorPinData is true but the node has no pin", async () => {
    const input = await buildInput({ honorPinData: true, pinData: { otherNode: {} } })
    const result = await runStep(input)

    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(result.output).toEqual({ real: true })
  })

  it("threads loop, trace, security, and formal-run provenance into the executor context", async () => {
    const executionBinding: NonNullable<RunStepInput["executionBinding"]> = {
      versionId: "wfv_parent_1",
      deploymentId: "wfd_parent",
      deploymentRevision: 3,
      entrypoint: "http",
      caller: "test",
      dependencyLock: { workflows: {}, indexes: {} },
    }
    const input = await buildInput({
      iterationMeta: { loopId: "loop1", iterationIndex: 2 },
      executionBinding,
      traceId: "trace-1",
      lineage: { rootRunId: "root-1", parentRunId: "parent-1" },
      securityContext: {
        piiEgressRequired: true,
        sourceTriggerKind: "trigger.connector.inbound",
      },
    })

    await runStep(input)

    expect(execSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        iteration: { loopId: "loop1", iterationIndex: 2 },
        executionBinding,
        traceId: "trace-1",
        lineage: { rootRunId: "root-1", parentRunId: "parent-1" },
        securityContext: {
          piiEgressRequired: true,
          sourceTriggerKind: "trigger.connector.inbound",
        },
      })
    )
  })

  it("coalesces commentary through a dedicated runtime event sink", async () => {
    execSpy.mockImplementationOnce(async (ctx) => {
      ctx.emitCommentary?.("Checking ")
      ctx.emitCommentary?.("the repository")
      return { output: { real: true } }
    })
    const input = await buildInput({})
    const commentarySpy = jest.spyOn(input.logger, "stepCommentary")

    await runStep(input)

    expect(commentarySpy).toHaveBeenCalledWith("n1", "Checking the repository", 0)
  })
})

describe("circuit breaker integration", () => {
  it("fail-fasts with CircuitOpenError once the node's breaker trips, skipping the executor", async () => {
    const always = jest.fn(async () => {
      throw new Error("boom")
    })
    registerNodeExecutor({ kind: "io.http", typeVersion: 1, execute: always })

    const cbNode: WorkflowNode = {
      id: "n_cb",
      type: "io.http",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: {
        label: "cb",
        params: { url: "https://example.com" },
        errorHandling: {
          // No retries (terminal on the first throw) + breaker trips after 2.
          retry: { maxRetries: 0, retryIntervalMs: 0, backoff: "fixed" },
          circuitBreaker: { threshold: 2, cooldownMs: 60_000 },
        },
      },
    }

    const run = async (runId: string) =>
      runStep({
        workflow: { ...makeWorkflow(), nodes: [cbNode] },
        node: cbNode,
        trigger,
        upstream: {},
        runId,
        signal: new AbortController().signal,
        cache: await IdempotencyCache.hydrate(runId),
        retryPolicy: { attempts: 1, backoff: "fixed", baseMs: 0 },
        secretResolver: NoopSecretResolver,
        logger: createRunLogger(runId),
      })

    await expect(run("cb_1")).rejects.toThrow("boom")
    await expect(run("cb_2")).rejects.toThrow("boom")
    // Breaker now open — third call short-circuits before the executor runs.
    await expect(run("cb_3")).rejects.toBeInstanceOf(CircuitOpenError)
    expect(always).toHaveBeenCalledTimes(2)

    const events = await listRunEvents("cb_3")
    const failed = events.find((e) => e.type === "step_failed")
    expect((failed?.payload as { message?: string })?.message).toMatch(/circuit breaker/i)
  })

  it("a success resets the breaker counter", async () => {
    const seq = jest
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockResolvedValueOnce({ output: { ok: true } })
      .mockRejectedValueOnce(new Error("e2"))
    registerNodeExecutor({ kind: "ai.embed", typeVersion: 1, execute: seq })

    const cbNode: WorkflowNode = {
      id: "n_cb2",
      type: "ai.embed",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: {
        label: "cb2",
        params: { input: "breaker reset" },
        errorHandling: {
          retry: { maxRetries: 0, retryIntervalMs: 0, backoff: "fixed" },
          circuitBreaker: { threshold: 2, cooldownMs: 60_000 },
        },
      },
    }
    const run = async (runId: string) =>
      runStep({
        workflow: { ...makeWorkflow(), nodes: [cbNode] },
        node: cbNode,
        trigger,
        upstream: {},
        runId,
        signal: new AbortController().signal,
        cache: await IdempotencyCache.hydrate(runId),
        retryPolicy: { attempts: 1, backoff: "fixed", baseMs: 0 },
        secretResolver: NoopSecretResolver,
        logger: createRunLogger(runId),
      })

    await expect(run("r1")).rejects.toThrow("e1") // 1 failure
    await expect(run("r2")).resolves.toMatchObject({ output: { ok: true } }) // reset
    await expect(run("r3")).rejects.toThrow("e2") // 1 failure again — still closed
    // Breaker never opened, so the executor ran all three times.
    expect(seq).toHaveBeenCalledTimes(3)
  })
})

describe("resolveStepRetryPolicy", () => {
  const workflowDefault = {
    attempts: 3,
    backoff: "exponential" as const,
    baseMs: 1000,
    maxMs: 30_000,
  }

  it("falls back to the workflow default without node errorHandling", () => {
    expect(resolveStepRetryPolicy(node, workflowDefault)).toBe(workflowDefault)
  })

  it("maps node retry settings (maxRetries = extra attempts)", () => {
    const withRetry: WorkflowNode = {
      ...node,
      data: {
        ...node.data,
        errorHandling: {
          retry: { maxRetries: 2, retryIntervalMs: 500, backoff: "fixed", maxIntervalMs: 4000 },
        },
      },
    }
    expect(resolveStepRetryPolicy(withRetry, workflowDefault)).toEqual({
      attempts: 3,
      backoff: "fixed",
      baseMs: 500,
      maxMs: 4000,
    })
  })

  it("maxRetries 0 disables retries even when the workflow default retries", () => {
    const noRetry: WorkflowNode = {
      ...node,
      data: {
        ...node.data,
        errorHandling: { retry: { maxRetries: 0, retryIntervalMs: 0, backoff: "fixed" } },
      },
    }
    expect(resolveStepRetryPolicy(noRetry, workflowDefault).attempts).toBe(1)
  })
})

describe("per-node retry runtime", () => {
  it("honors the node retry policy and emits step_retrying before each wait", async () => {
    const flaky = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockResolvedValueOnce({ output: { ok: true } })
    registerNodeExecutor({ kind: "data.template", typeVersion: 1, execute: flaky })

    const retryNode: WorkflowNode = {
      id: "n_retry",
      type: "data.template",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: {
        label: "flaky",
        params: { template: "retry me" },
        errorHandling: { retry: { maxRetries: 1, retryIntervalMs: 0, backoff: "fixed" } },
      },
    }
    const runId = "run_retry"
    const result = await runStep({
      workflow: { ...makeWorkflow(), nodes: [retryNode] },
      node: retryNode,
      trigger,
      upstream: {},
      runId,
      signal: new AbortController().signal,
      cache: await IdempotencyCache.hydrate(runId),
      // Workflow default says NO retries — the node's own policy must win.
      retryPolicy: { attempts: 1, backoff: "fixed", baseMs: 0 },
      secretResolver: NoopSecretResolver,
      logger: createRunLogger(runId),
    })

    expect(result.output).toEqual({ ok: true })
    expect(flaky).toHaveBeenCalledTimes(2)
    const events = await listRunEvents(runId)
    const retrying = events.filter((e) => e.type === "step_retrying")
    expect(retrying).toHaveLength(1)
    expect(retrying[0].payload).toEqual(
      expect.objectContaining({ attempt: 1, maxAttempts: 2, error: "transient 1" })
    )
  })
})

describe("runtime parameter and timeout integrity", () => {
  it("rejects invalid authored params before invoking the executor", async () => {
    const execute = jest.fn(async () => ({ output: "should not run" }))
    registerNodeExecutor({ kind: "action.character.send", typeVersion: 99, execute })
    const invalidNode: WorkflowNode = {
      id: "n_invalid_params",
      type: "action.character.send",
      typeVersion: 99,
      position: { x: 0, y: 0 },
      data: { label: "invalid", params: {} },
    }
    const runId = "run_invalid_params"

    await expect(
      runStep({
        workflow: { ...makeWorkflow(), nodes: [invalidNode] },
        node: invalidNode,
        trigger,
        upstream: {},
        runId,
        signal: new AbortController().signal,
        cache: await IdempotencyCache.hydrate(runId),
        retryPolicy: { attempts: 1, backoff: "fixed", baseMs: 0 },
        secretResolver: NoopSecretResolver,
        logger: createRunLogger(runId),
      })
    ).rejects.toThrow(/Invalid params.*characterId/i)
    expect(execute).not.toHaveBeenCalled()
  })

  it("rejects and aborts a non-cooperative executor at its effective timeout", async () => {
    let executorSignal: AbortSignal | undefined
    const execute = jest.fn(
      async (ctx: { signal: AbortSignal }) =>
        new Promise<{ output: unknown }>(() => {
          executorSignal = ctx.signal
        })
    )
    registerNodeExecutor({
      kind: "data.code",
      typeVersion: 99,
      execute: execute as never,
      timeoutMs: 20,
      retryable: false,
    })
    const slowNode: WorkflowNode = {
      id: "n_timeout",
      type: "data.code",
      typeVersion: 99,
      position: { x: 0, y: 0 },
      data: { label: "slow", params: { code: "return null" } },
    }
    const runId = "run_timeout"

    await expect(
      runStep({
        workflow: { ...makeWorkflow(), nodes: [slowNode] },
        node: slowNode,
        trigger,
        upstream: {},
        runId,
        signal: new AbortController().signal,
        cache: await IdempotencyCache.hydrate(runId),
        retryPolicy: { attempts: 1, backoff: "fixed", baseMs: 0 },
        secretResolver: NoopSecretResolver,
        logger: createRunLogger(runId),
      })
    ).rejects.toThrow(/Step exceeded timeout \(20ms\)/)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(executorSignal?.aborted).toBe(true)
  })

  it("enforces a plugin node's registered JSON params schema at runtime", async () => {
    const kind = "demo.action.secure" as WorkflowNode["type"]
    const execute = jest.fn(async () => ({ output: "should not run" }))
    addPluginCatalogEntry({
      kind,
      typeVersion: 3,
      category: "plugin",
      label: "Secure",
      description: "Requires a token",
      iconName: "Lock",
      keywords: [],
      pluginId: "demo",
      paramsSchema: {
        type: "object",
        required: ["token"],
        properties: { token: { type: "string" } },
      },
    })
    registerNodeExecutor({ kind, typeVersion: 3, execute })
    const pluginNode: WorkflowNode = {
      id: "n_plugin_params",
      type: kind,
      typeVersion: 3,
      position: { x: 0, y: 0 },
      data: { label: "secure", params: {} },
    }
    const runId = "run_plugin_params"

    await expect(
      runStep({
        workflow: { ...makeWorkflow(), nodes: [pluginNode] },
        node: pluginNode,
        trigger,
        upstream: {},
        runId,
        signal: new AbortController().signal,
        cache: await IdempotencyCache.hydrate(runId),
        retryPolicy: { attempts: 1, backoff: "fixed", baseMs: 0 },
        secretResolver: NoopSecretResolver,
        logger: createRunLogger(runId),
      })
    ).rejects.toThrow(/Invalid params.*token/i)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe("runStep with no registered executor", () => {
  async function inputForKind(kind: string): Promise<RunStepInput> {
    const base = await buildInput({})
    const missing: WorkflowNode = { ...node, type: kind as WorkflowNode["type"] }
    return { ...base, node: missing, workflow: { ...base.workflow, nodes: [missing] } }
  }

  it("tells the user a retired kind was removed instead of naming a plugin to install", async () => {
    const input = await inputForKind("action.github.runIssueLoop")
    await expect(runStep(input)).rejects.toThrow(
      /action\.github\.runIssueLoop was removed in 0\.2\.0/
    )
    // The advice for an uninstalled plugin would be actionable; for a retired
    // kind it is not, so it must not appear.
    await expect(runStep(await inputForKind("action.github.runIssueLoop"))).rejects.not.toThrow(
      /No executor registered/
    )
  })

  it("keeps the install-the-plugin message for an unavailable kind that was never retired", async () => {
    const input = await inputForKind("action.acme.doThing")
    await expect(runStep(input)).rejects.toThrow(/No executor registered for action\.acme\.doThing/)
  })

  it("records the failure as non-retryable on the run timeline", async () => {
    await expect(runStep(await inputForKind("action.github.runIssueLoop"))).rejects.toThrow()
    const events = await listRunEvents("run_1")
    const failed = events.find((e) => e.type === "step_failed")
    expect(failed).toBeDefined()
    expect((failed?.payload as { retryable?: boolean })?.retryable).toBe(false)
    expect((failed?.payload as { message?: string })?.message).toMatch(/removed in 0\.2\.0/)
  })
})

describe("plugin dependency lock enforcement", () => {
  it("rejects a drifted custom plugin before invoking its executor", async () => {
    const kind = "demo.plugin.action.locked" as WorkflowNode["type"]
    const execute = jest.fn(async () => ({ output: "unreachable" }))
    registerNodeExecutor({ kind, typeVersion: 1, execute, pluginId: "demo.plugin" })
    const manifest = {
      id: "demo.plugin",
      version: "2.0.0",
      name: "Demo",
      description: "Demo",
      type: "frontend",
      capabilities: ["workflow"],
    }
    await getDb().plugins.put({
      id: "demo.plugin",
      name: "Demo",
      version: "2.0.0",
      status: "enabled",
      source: "builtin",
      type: "frontend",
      enabled: true,
      capabilities: ["workflow"],
      path: "builtin://demo.plugin",
      manifest,
      createdAt: 1,
      updatedAt: 1,
    })
    const pluginNode: WorkflowNode = {
      id: "n_locked",
      type: kind,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Locked", params: {} },
    }
    const base = await buildInput({})

    await expect(
      runStep({
        ...base,
        node: pluginNode,
        workflow: { ...base.workflow, nodes: [pluginNode] },
        executionBinding: {
          versionId: "version-1",
          deploymentId: "deployment-1",
          deploymentRevision: 1,
          entrypoint: "portal",
          caller: "portal",
          dependencyLock: {
            workflows: {},
            indexes: {},
            plugins: {
              "demo.plugin": {
                pluginId: "demo.plugin",
                version: "1.0.0",
                manifestDigest: workflowVersionDigest(manifest),
                capabilities: ["workflow"],
                runtimeProfile: "headless",
              },
            },
          },
        },
      })
    ).rejects.toMatchObject({ code: "plugin-version-drift", retryable: false })
    expect(execute).not.toHaveBeenCalled()
  })
})

/**
 * Credential bindings live on the node's `data`, not its `params`, so the
 * step executor has to hand them to the context explicitly. Without this the
 * whole workflow-credentials feature was inert: the settings panel declared
 * refs, `checkCredentials` validated them, and no executor could ever read one.
 */
describe("credential refs reach the executor", () => {
  it("passes the node's credentialRefs into the execution context", async () => {
    const input = await buildInput({})
    const withRefs: WorkflowNode = {
      ...node,
      data: { ...node.data, credentialRefs: { apiKey: "keyring:wf:openai" } },
    }
    await runStep({
      ...input,
      node: withRefs,
      workflow: { ...input.workflow, nodes: [withRefs] },
    })
    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(execSpy.mock.calls[0]![0].credentialRefs).toEqual({ apiKey: "keyring:wf:openai" })
  })

  it("leaves the field absent when the node binds nothing", async () => {
    await runStep(await buildInput({}))
    expect(execSpy.mock.calls[0]![0].credentialRefs).toBeUndefined()
  })
})
