/**
 * Staged conversation seeding for product recordings (ADR-0092, product
 * footage amendment).
 *
 * The website's films and screenshots show the real chat surface carrying one
 * demo task: a request, the files the agent read, a failing check, a diff, a
 * halt on approval and an artifact. The browser-only build cannot produce that
 * turn live — its chat engine has no native Read/Bash/Edit tools and permission
 * requests only arrive from the desktop sidecar — so a recording drives the
 * real renderers with seeded parts instead, one stage at a time, and the
 * camera watches them land.
 *
 * Dev/E2E only — reached exclusively through `expose-test-globals.tsx`, which
 * installs nothing unless `NEXT_PUBLIC_E2E === "1"`. That is a runtime check:
 * a production build still ships this module as a lazy chunk, but the gate
 * never passes there, so the chunk is never fetched.
 *
 * Split the same way as `chat-perf-fixtures.ts`: the transcript arithmetic
 * (`applyStage`, `streamSteps`) is pure and unit-testable in jsdom, and the
 * runner takes every side effect — persistence, the live store, plans,
 * artifacts, the clock — as injected dependencies. The module knows nothing
 * about the website's demo; the caller passes the script.
 */

/** A message as the seam writes it: the `UIMessage` shape, loosely typed. */
export interface StagedMessage {
  id: string
  role: "user" | "assistant"
  parts: Array<Record<string, unknown>>
  metadata?: Record<string, unknown>
}

/** Append a whole message (a user request, or an assistant turn's opening). */
export interface AppendStage {
  kind: "append"
  message: StagedMessage
}

/**
 * Type `text` into a fresh text part at the end of `messageId`, `chunkSize`
 * characters every `intervalMs`, so the camera sees the reply arrive the way a
 * streamed one does.
 */
export interface StreamStage {
  kind: "stream"
  messageId: string
  text: string
  /** Characters per tick. Default 3. */
  chunkSize?: number
  /** Milliseconds between ticks. Default 24. */
  intervalMs?: number
}

/** Append one part (usually a tool call in `input-available`) to a message. */
export interface AddPartStage {
  kind: "addPart"
  messageId: string
  part: Record<string, unknown>
}

/**
 * Move an existing tool part forward — `input-available` → `output-available`
 * / `output-error` / `approval-requested` — by merging `patch` into it.
 */
export interface PatchPartStage {
  kind: "patchPart"
  messageId: string
  toolCallId: string
  patch: Record<string, unknown>
}

/** Seed the session's plan, parked on `awaiting_approval`. */
export interface PlanStage {
  kind: "plan"
  title: string
  planText?: string
  stepTitles: string[]
}

/**
 * Create an artifact in the artifact store and append its inline card to
 * `messageId`.
 */
export interface ArtifactStage {
  kind: "artifact"
  messageId: string
  title: string
  content: string
  artifactType: "code" | "document"
  language?: string
}

/**
 * Raise a pending tool approval for a call already in the transcript, which is
 * what the sidecar's `permission_request` does in a live turn: the session's
 * real approval dialog opens on it.
 */
export interface ApprovalStage {
  kind: "approval"
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  description?: string
}

export type DemoStage =
  | ApprovalStage
  | AppendStage
  | StreamStage
  | AddPartStage
  | PatchPartStage
  | PlanStage
  | ArtifactStage

export interface StagedConversationScript {
  title: string
  stages: DemoStage[]
}

export const DEFAULT_STREAM_CHUNK = 3
export const DEFAULT_STREAM_INTERVAL_MS = 24

/**
 * The successive values of a streamed text part: every prefix of `text` at a
 * `chunkSize` stride, ending on the whole string. An empty string yields one
 * empty frame, so the part still exists afterwards.
 */
export function streamSteps(text: string, chunkSize = DEFAULT_STREAM_CHUNK): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`streamSteps: chunkSize must be a positive integer, got ${chunkSize}`)
  }
  if (text.length === 0) return [""]
  const steps: string[] = []
  for (let end = chunkSize; end < text.length; end += chunkSize) steps.push(text.slice(0, end))
  steps.push(text)
  return steps
}

function requireMessage(messages: StagedMessage[], messageId: string, stage: string): number {
  const index = messages.findIndex((m) => m.id === messageId)
  if (index === -1) throw new Error(`${stage}: no message ${messageId} in the transcript`)
  return index
}

function replaceAt(messages: StagedMessage[], index: number, next: StagedMessage): StagedMessage[] {
  return messages.map((m, i) => (i === index ? next : m))
}

/** Append `part` to message `messageId`. */
export function withPart(
  messages: StagedMessage[],
  messageId: string,
  part: Record<string, unknown>
): StagedMessage[] {
  const index = requireMessage(messages, messageId, "addPart")
  const target = messages[index]
  return replaceAt(messages, index, { ...target, parts: [...target.parts, part] })
}

/** Replace the text of the LAST part of `messageId`, which must be a text part. */
export function withLastText(
  messages: StagedMessage[],
  messageId: string,
  text: string
): StagedMessage[] {
  const index = requireMessage(messages, messageId, "stream")
  const target = messages[index]
  const last = target.parts[target.parts.length - 1]
  if (!last || last.type !== "text") {
    throw new Error(`stream: message ${messageId} does not end on a text part`)
  }
  return replaceAt(messages, index, {
    ...target,
    parts: [...target.parts.slice(0, -1), { ...last, text }],
  })
}

/** Merge `patch` into the tool part whose `toolCallId` matches. */
export function withPatchedPart(
  messages: StagedMessage[],
  messageId: string,
  toolCallId: string,
  patch: Record<string, unknown>
): StagedMessage[] {
  const index = requireMessage(messages, messageId, "patchPart")
  const target = messages[index]
  const partIndex = target.parts.findIndex((p) => p.toolCallId === toolCallId)
  if (partIndex === -1) {
    throw new Error(`patchPart: message ${messageId} has no tool part ${toolCallId}`)
  }
  return replaceAt(messages, index, {
    ...target,
    parts: target.parts.map((p, i) => (i === partIndex ? { ...p, ...patch } : p)),
  })
}

/** Stamp the session id and a monotonic `createdAt` onto a message. */
export function stampMessage(
  message: StagedMessage,
  sessionId: string,
  createdAt: number
): StagedMessage {
  return { ...message, metadata: { ...message.metadata, sessionId, createdAt } }
}

/** Throws on a script the runner could not play to the end. */
export function validateScript(script: StagedConversationScript): void {
  if (script.stages.length === 0) throw new Error("staged conversation: no stages")
  const known = new Set<string>()
  const tools = new Set<string>()
  script.stages.forEach((stage, i) => {
    const at = `stage ${i} (${stage.kind})`
    switch (stage.kind) {
      case "append":
        if (known.has(stage.message.id)) throw new Error(`${at}: duplicate id ${stage.message.id}`)
        known.add(stage.message.id)
        for (const part of stage.message.parts) {
          if (typeof part.toolCallId === "string") tools.add(part.toolCallId)
        }
        return
      case "addPart":
        if (!known.has(stage.messageId)) throw new Error(`${at}: unknown ${stage.messageId}`)
        if (typeof stage.part.toolCallId === "string") tools.add(stage.part.toolCallId)
        return
      case "patchPart":
        if (!known.has(stage.messageId)) throw new Error(`${at}: unknown ${stage.messageId}`)
        if (!tools.has(stage.toolCallId)) throw new Error(`${at}: unknown ${stage.toolCallId}`)
        return
      case "stream":
      case "artifact":
        if (!known.has(stage.messageId)) throw new Error(`${at}: unknown ${stage.messageId}`)
        return
      case "plan":
        if (stage.stepTitles.length === 0) throw new Error(`${at}: a plan needs steps`)
        return
      case "approval":
        if (!tools.has(stage.toolCallId)) throw new Error(`${at}: unknown ${stage.toolCallId}`)
        return
    }
  })
}

export interface StagedConversationDeps {
  /** Persist the changed messages (an upsert, never a transcript replace). */
  persist: (sessionId: string, upserts: StagedMessage[]) => Promise<void>
  /** Hand the whole transcript to the live chat store for the open view. */
  publish: (sessionId: string, messages: StagedMessage[]) => void
  seedPlan: (draft: {
    sessionId: string
    title: string
    planText?: string
    stepTitles: string[]
  }) => Promise<string>
  requestApproval: (approval: {
    sessionId: string
    requestId: string
    toolUseID: string
    toolName: string
    input: Record<string, unknown>
    title?: string
    description?: string
  }) => void
  /** Returns the created artifact's id. */
  createArtifact: (params: {
    sessionId: string
    messageId: string
    type: "code" | "document"
    title: string
    content: string
    language?: string
  }) => string
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface StagedConversation {
  readonly sessionId: string
  readonly stageCount: number
  /** Play the next stage to completion. */
  advance: () => Promise<{ index: number; done: boolean }>
  /** The transcript as the seam last wrote it. */
  messages: () => StagedMessage[]
}

/**
 * A conversation that plays `script` one stage per `advance()`. Stages must be
 * advanced in order and never concurrently: a second call while one is still
 * streaming is refused rather than interleaved.
 */
export function createStagedConversation(
  sessionId: string,
  script: StagedConversationScript,
  deps: StagedConversationDeps
): StagedConversation {
  validateScript(script)
  let messages: StagedMessage[] = []
  let next = 0
  let busy = false
  let clock = deps.now()

  const commit = async (changedId: string) => {
    const changed = messages.find((m) => m.id === changedId)
    if (changed) await deps.persist(sessionId, [changed])
    deps.publish(sessionId, messages)
  }

  const play = async (stage: DemoStage) => {
    switch (stage.kind) {
      case "append":
        messages = [...messages, stampMessage(stage.message, sessionId, clock++)]
        await commit(stage.message.id)
        return
      case "addPart":
        messages = withPart(messages, stage.messageId, stage.part)
        await commit(stage.messageId)
        return
      case "patchPart":
        messages = withPatchedPart(messages, stage.messageId, stage.toolCallId, stage.patch)
        await commit(stage.messageId)
        return
      case "stream": {
        messages = withPart(messages, stage.messageId, { type: "text", text: "" })
        const interval = stage.intervalMs ?? DEFAULT_STREAM_INTERVAL_MS
        const steps = streamSteps(stage.text, stage.chunkSize ?? DEFAULT_STREAM_CHUNK)
        for (const [i, text] of steps.entries()) {
          messages = withLastText(messages, stage.messageId, text)
          // Only the final frame goes to storage; the intermediate ones exist
          // for the camera, and a write per keystroke would be the slow part.
          if (i === steps.length - 1) await commit(stage.messageId)
          else deps.publish(sessionId, messages)
          if (i < steps.length - 1) await deps.sleep(interval)
        }
        return
      }
      case "plan":
        await deps.seedPlan({
          sessionId,
          title: stage.title,
          planText: stage.planText,
          stepTitles: stage.stepTitles,
        })
        return
      case "approval":
        deps.requestApproval({
          sessionId,
          requestId: `demo-approval-${stage.toolCallId}`,
          toolUseID: stage.toolCallId,
          toolName: stage.toolName,
          input: stage.input,
          title: stage.title,
          description: stage.description,
        })
        return
      case "artifact": {
        const artifactId = deps.createArtifact({
          sessionId,
          messageId: stage.messageId,
          type: stage.artifactType,
          title: stage.title,
          content: stage.content,
          language: stage.language,
        })
        messages = withPart(messages, stage.messageId, {
          type: "artifact",
          artifactId,
          title: stage.title,
          kind: stage.artifactType,
          defaultOpen: true,
        })
        await commit(stage.messageId)
        return
      }
    }
  }

  return {
    sessionId,
    stageCount: script.stages.length,
    messages: () => messages,
    async advance() {
      if (busy) throw new Error("staged conversation: advance() called while a stage is playing")
      if (next >= script.stages.length) return { index: next - 1, done: true }
      busy = true
      const index = next
      // A stage that fails part-way leaves the transcript as it was, so a
      // retry replays it cleanly instead of appending the same message twice.
      const snapshot = messages
      try {
        await play(script.stages[index])
        next += 1
      } catch (error) {
        messages = snapshot
        throw error
      } finally {
        busy = false
      }
      return { index, done: next >= script.stages.length }
    },
  }
}
