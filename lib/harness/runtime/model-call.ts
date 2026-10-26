/**
 * One model call for a Harness Evolution role (ADR-0237).
 *
 * The structured editor, the composer, the selector and the reflector call a
 * model directly from the renderer through the shared client factory
 * (`buildRendererLlmClient`), the same rail the `/goal` judge and the utility
 * tasks use. Each call:
 *
 * - picks the role's model: the run's choice for that role, else the agent's
 *   own provider and model;
 * - passes the PII gate on everything it sends. Evidence is redacted when it
 *   is recorded, but the harness itself (the agent's own prompt and skills)
 *   is not, and these calls run unattended, so a leak stops the call instead
 *   of being sent;
 * - books its tokens under the `harness-evolution` usage surface and the
 *   run's id, and reports them back for the run's ledger.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { hasNoLeakingPii } from "@cognia/redact"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { SurfaceUsageInput } from "@/lib/db/session-usage"
import type { HarnessRole, HarnessRoleModel, HarnessRoleModels } from "@/types/harness/evolution"
import type { ProbeUsage, ProbeUsageBooking } from "./probe-runner"

export const HARNESS_MODEL_FEATURE_ID = "harness-evolution"

export class HarnessModelUnavailableError extends Error {
  constructor(readonly role: HarnessRole) {
    super(
      `No model with a key this app can call directly is configured for the harness ${role}. Choose a ${role} model in the Harness Evolution settings or give the agent's provider an API key.`
    )
    this.name = "HarnessModelUnavailableError"
  }
}

export class HarnessPiiBlockedError extends Error {
  constructor(readonly role: HarnessRole) {
    super(
      `The ${role} call was not sent: its input contains personal data (the agent's harness or the task). Remove it from the harness or the task and start a new run.`
    )
    this.name = "HarnessPiiBlockedError"
  }
}

export interface HarnessModelDeps {
  getSettings(): Promise<AppSettings | null>
  buildClient(args: {
    appSettings: AppSettings
    providerOverride?: string
    modelOverride?: string
  }): LlmClient | null
  bookUsage(input: {
    operationId: string
    sessionId: string
    usage: SurfaceUsageInput
  }): Promise<ProbeUsageBooking | null>
}

/** The model a role uses: the run's choice, else the agent's own. */
export function roleModel(
  role: HarnessRole,
  models: HarnessRoleModels,
  agent: { providerId?: string; model?: string }
): HarnessRoleModel {
  const chosen = models[role] ?? (role === "composer" ? models.editor : undefined)
  if (chosen?.model || chosen?.providerId) {
    return {
      ...(chosen.providerId ? { providerId: chosen.providerId } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
    }
  }
  return {
    ...(agent.providerId ? { providerId: agent.providerId } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  }
}

export interface HarnessModelCallInput {
  role: HarnessRole
  model: HarnessRoleModel
  system: string
  prompt: string
  maxTokens: number
  runId: string
  /** Deterministic per call; a retried step uses a new attempt in it. */
  operationId: string
  signal: AbortSignal
}

interface CallUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export interface HarnessModelCallResult {
  text: string
  usage: ProbeUsage
  provider?: string
  model?: string
}

/** Build the client for a role, or `null` when none can be called from here. */
export async function clientForRole(
  model: HarnessRoleModel,
  deps: Pick<HarnessModelDeps, "getSettings" | "buildClient">
): Promise<LlmClient | null> {
  const appSettings = await deps.getSettings()
  if (!appSettings) return null
  return deps.buildClient({
    appSettings,
    ...(model.providerId ? { providerOverride: model.providerId } : {}),
    ...(model.model ? { modelOverride: model.model } : {}),
  })
}

export async function callHarnessModel(
  input: HarnessModelCallInput,
  deps: HarnessModelDeps
): Promise<HarnessModelCallResult> {
  input.signal.throwIfAborted()
  if (!hasNoLeakingPii(input.system) || !hasNoLeakingPii(input.prompt)) {
    throw new HarnessPiiBlockedError(input.role)
  }
  const client = await clientForRole(input.model, deps)
  if (!client) throw new HarnessModelUnavailableError(input.role)
  const before = client.reportsCallUsage ? undefined : client.getUsageSnapshot?.()
  let callUsage: CallUsage | undefined
  const usageOfCall = (): CallUsage | undefined => {
    if (callUsage || !before) return callUsage
    const after = client.getUsageSnapshot?.()
    return after
      ? {
          inputTokens: after.inputTokens - before.inputTokens,
          outputTokens: after.outputTokens - before.outputTokens,
          cacheReadTokens: (after.cacheReadTokens ?? 0) - (before.cacheReadTokens ?? 0),
        }
      : undefined
  }
  let text: string
  try {
    text = await client.complete(input.prompt, {
      system: input.system,
      maxTokens: input.maxTokens,
      temperature: 0,
      abortSignal: input.signal,
      onUsage: (usage) => {
        callUsage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
        }
      },
    })
  } catch (error) {
    // A failed call may still have been billed.
    await bookModelUsage(input, client, usageOfCall(), deps)
    throw error
  }
  const usage = await bookModelUsage(input, client, usageOfCall(), deps)
  return {
    text,
    usage,
    ...(client.provider ? { provider: client.provider } : {}),
    ...(client.model ? { model: client.model } : {}),
  }
}

async function bookModelUsage(
  input: HarnessModelCallInput,
  client: LlmClient,
  callUsage: CallUsage | undefined,
  deps: HarnessModelDeps
): Promise<ProbeUsage> {
  if (!callUsage) return { inputTokens: 0, outputTokens: 0, costUnknown: true }
  let booking: ProbeUsageBooking | null = null
  try {
    booking = await deps.bookUsage({
      operationId: input.operationId,
      sessionId: `harness:${input.runId}`,
      usage: {
        inputTokens: callUsage.inputTokens,
        outputTokens: callUsage.outputTokens,
        cacheReadTokens: callUsage.cacheReadTokens,
        ...(input.model.providerId ? { providerId: input.model.providerId } : {}),
        ...(client.model
          ? { model: client.model }
          : input.model.model
            ? { model: input.model.model }
            : {}),
        runId: input.runId,
      },
    })
  } catch (error) {
    console.warn("Harness model usage booking failed", error)
  }
  const costUsd = booking?.costKnown ? booking.costUsd : undefined
  return {
    inputTokens: callUsage.inputTokens,
    outputTokens: callUsage.outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
    costUnknown: costUsd === undefined,
  }
}

/** Production dependencies. */
export async function defaultHarnessModelDeps(): Promise<HarnessModelDeps> {
  const [settings, rendererClient, usageDb] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/lib/ai/renderer-llm-client"),
    import("@/lib/db/session-usage"),
  ])
  return {
    getSettings: async () => (await settings.getSettings()) ?? null,
    buildClient: ({ appSettings, providerOverride, modelOverride }) =>
      rendererClient.buildRendererLlmClient({
        session: null,
        appSettings,
        featureId: HARNESS_MODEL_FEATURE_ID,
        ...(providerOverride ? { providerOverride } : {}),
        ...(modelOverride ? { modelOverride } : {}),
        ledgerSurface: "agentsWorkflows",
      }),
    bookUsage: async ({ operationId, sessionId, usage }) => {
      const row = await usageDb.recordSurfaceUsage({
        surface: "harness-evolution",
        operationId,
        sessionId,
        usage,
      })
      return row ? { costUsd: row.costUsd, costKnown: row.costKnown !== false } : null
    },
  }
}
