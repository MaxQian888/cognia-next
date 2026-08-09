import type { UIMessage } from "ai"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { loggers } from "@cognia/logging"

import { listMessages } from "@/lib/db/messages"
import { checkpointRecording, createRecording } from "@/lib/db/skill-recordings"
import { getDb } from "@/lib/db/schema"
import type { StepEdits } from "@/lib/skills/recording/step-model"
import { useRecorderStore } from "@/stores/skills/recorder-store"

const log = loggers.agent.child("skill-suggestion")
const MAX_SOURCE_STEPS = 80
const MAX_STEP_CHARS = 1_200

export interface SkillSuggestionOutcome {
  completed: boolean
  turns: number
  errorCount: number
  denialCount: number
  toolCallTotal: number
  passedTests: number
  failedTests: number
  commitCount: number
}

export type SkillSuggestionSource =
  | { kind: "session"; sessionId: string }
  | { kind: "run"; runId: string; sessionId?: string }

export function isSkillSuggestionEligible(outcome: SkillSuggestionOutcome): boolean {
  if (!outcome.completed || outcome.turns < 2) return false
  if (outcome.errorCount > 0 || outcome.denialCount > 0 || outcome.failedTests > 0) return false
  return outcome.toolCallTotal >= 2 || outcome.passedTests > 0 || outcome.commitCount > 0
}

function textParts(message: UIMessage): string[] {
  const labels: string[] = []
  for (const raw of message.parts ?? []) {
    const part = raw as { type?: string; text?: string; state?: string }
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      labels.push(part.text.trim())
    } else if (part.type?.startsWith("tool-") && part.state === "output-available") {
      labels.push(`Used ${part.type.slice(5)} successfully`)
    }
  }
  return labels
}

function redactStep(label: string, text: string): string {
  const bounded = `${label}: ${text}`.slice(0, MAX_STEP_CHARS)
  const redacted = redactText(bounded).redacted
  if (!hasNoLeakingPii(redacted)) throw new Error("skill-source-pii-gate-failed")
  return redacted
}

function messagesToIntents(messages: readonly UIMessage[]): string[] {
  const intents: string[] = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue
    const label = message.role === "user" ? "User request" : "Agent response"
    for (const text of textParts(message)) {
      intents.push(redactStep(label, text))
      if (intents.length >= MAX_SOURCE_STEPS) return intents
    }
  }
  return intents
}

async function loadSourceIntents(source: SkillSuggestionSource): Promise<string[]> {
  if (source.kind === "session") return messagesToIntents(await listMessages(source.sessionId))

  const attempt = await getDb().agentTaskAttempts.get(source.runId)
  if (!attempt || (attempt.status !== "completed" && attempt.status !== "review")) {
    throw new Error("skill-source-not-successful")
  }
  const intents: string[] = []
  if (attempt.sessionId) intents.push(...messagesToIntents(await listMessages(attempt.sessionId)))
  if (attempt.result?.trim()) intents.push(redactStep("Successful run result", attempt.result))
  return intents.slice(0, MAX_SOURCE_STEPS)
}

function toManualEdits(intents: readonly string[]): StepEdits {
  return {
    bySeq: {},
    manual: intents.map((intent, index) => ({
      seq: -(index + 1),
      afterSeq: index === 0 ? 0 : -index,
      intent,
    })),
  }
}

export async function prepareSkillRecordingFromSource(
  source: SkillSuggestionSource
): Promise<{ recordingId: string; stepCount: number }> {
  const current = useRecorderStore.getState()
  if (["recording", "paused", "stopping"].includes(current.phase)) {
    throw new Error("skill-recorder-busy")
  }

  const intents = await loadSourceIntents(source)
  if (intents.length === 0) throw new Error("skill-source-empty")

  const recordingId = crypto.randomUUID()
  const edits = toManualEdits(intents)
  await createRecording({ id: recordingId, status: "drafting", source })
  await checkpointRecording(recordingId, {
    edits,
    stepCount: intents.length,
    includedCount: intents.length,
    bundleBytes: 0,
  })

  current.reset()
  useRecorderStore.getState().setEdits(edits)
  const state = useRecorderStore.getState()
  state.dispatch({
    type: "REATTACH",
    snapshot: {
      ...state,
      phase: "review",
      recordingId,
      bundleId: recordingId,
      steps: state.steps,
      inputVariables: [],
      draft: null,
      candidateDraft: null,
      generation: null,
      savedSkillId: null,
      error: null,
      interrupt: null,
    },
  })
  state.dispatch({ type: "OPEN", source: "session-suggestion" })
  log.info("skill suggestion accepted", {
    sourceKind: source.kind,
    sourceId: source.kind === "session" ? source.sessionId : source.runId,
    recordingId,
    stepCount: intents.length,
  })
  return { recordingId, stepCount: intents.length }
}
