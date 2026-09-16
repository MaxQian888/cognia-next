import type { SendContent, SendOptions } from "@cognia/agent-config-types"

import { sendPrompt } from "@/lib/claude/ipc"
import { getWorkSubmissionBundle, type WorkSubmissionRow } from "@/lib/db/work-submissions"
import { abortRouterFusionSend, prepareRouterFusionSend } from "@/lib/router-fusion/gate/chat-send"
import { useSettingsStore } from "@/stores/settings"

import { openWorkSubmissionPayload, type WorkSubmissionCryptoDeps } from "./crypto"
import type { WorkDispatchOutcome } from "./outbox-runner"
import {
  executionContextDigest,
  workInputDigest,
  type FrozenExecutionContext,
  type FrozenWorkInput,
} from "./service"

interface StoredChatDispatchDeps extends WorkSubmissionCryptoDeps {
  getBundle?: typeof getWorkSubmissionBundle
  /** Test seam for the Router + Fusion replay step. */
  prepareRouterFusionSend?: typeof prepareRouterFusionSend
}

function recoveryRequired(errorCode: string): WorkDispatchOutcome {
  return { status: "recovery_required", errorCode }
}

function parseFrozenInput(value: string): FrozenWorkInput | null {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object") return null
  const input = parsed as Partial<FrozenWorkInput>
  if (!Array.isArray(input.visibleMessageIds) || !Array.isArray(input.attachments)) return null
  return input as FrozenWorkInput
}

function parseFrozenContext(value: string): FrozenExecutionContext | null {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const context = parsed as FrozenExecutionContext
  if (!context.sendOptions || typeof context.sendOptions !== "object") return null
  return context
}

/**
 * Recreate a Direct Chat handoff strictly from the encrypted accepted payload.
 *
 * This deliberately calls the same `sendPrompt` boundary as the live chat and
 * HostState paths. It does not resolve a model, workspace, or provider again:
 * the persisted copy is authoritative, and missing proof parks the turn.
 */
export function createStoredChatDispatch(
  deps: StoredChatDispatchDeps = {}
): (row: WorkSubmissionRow) => Promise<WorkDispatchOutcome> {
  return async (row) => {
    if (row.sourceKind !== "chat" || !row.sessionId) {
      return { status: "failed", errorCode: "unsupported_submission_source" }
    }

    const bundle = await (deps.getBundle ?? getWorkSubmissionBundle)(row.id)
    if (!bundle?.inputBatch) return recoveryRequired("missing_frozen_input")
    if (!bundle.contextBundle) return recoveryRequired("missing_frozen_context")

    let input: FrozenWorkInput | null
    let context: FrozenExecutionContext | null
    try {
      const [inputJson, contextJson] = await Promise.all([
        openWorkSubmissionPayload(
          bundle.inputBatch.envelope,
          { accountId: row.accountId, submissionId: row.id, kind: "input-batch" },
          deps
        ),
        openWorkSubmissionPayload(
          bundle.contextBundle.envelope,
          { accountId: row.accountId, submissionId: row.id, kind: "context-bundle" },
          deps
        ),
      ])
      input = parseFrozenInput(inputJson)
      context = parseFrozenContext(contextJson)
    } catch {
      return recoveryRequired("frozen_payload_unreadable")
    }

    if (!input) return recoveryRequired("invalid_frozen_input")
    if (!context) return recoveryRequired("missing_frozen_send_options")
    if (workInputDigest(input) !== bundle.inputBatch.digest) {
      return recoveryRequired("frozen_input_digest_mismatch")
    }
    if (executionContextDigest(context) !== bundle.contextBundle.digest) {
      return recoveryRequired("frozen_context_digest_mismatch")
    }

    // Router + Fusion (ADR-0188): the frozen stamp names a run that ended with
    // the window that accepted the turn. A replay is a new run on the SAME
    // deployment — re-checked against the hard filters, never re-resolved.
    let sendOptions = context.sendOptions as SendOptions
    if (sendOptions.routerFusion) {
      const fusionSend = await (deps.prepareRouterFusionSend ?? prepareRouterFusionSend)({
        sessionId: row.sessionId,
        options: sendOptions,
        reused: true,
        workspaceId: context.projectId ?? null,
        settings: useSettingsStore.getState().settings,
      })
      if (fusionSend.kind === "refused") {
        return { status: "failed", errorCode: `router_fusion_refused:${fusionSend.code}` }
      }
      sendOptions = fusionSend.options
    }

    try {
      await sendPrompt(row.sessionId, input.content as SendContent, sendOptions, {
        commandId: row.triggerId ?? row.id,
      })
    } catch (error) {
      await abortRouterFusionSend(
        row.sessionId,
        sendOptions,
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
    return { status: "dispatched" }
  }
}
