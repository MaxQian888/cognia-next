import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import {
  runEventJournal,
  semanticRunEvent,
  type AppendRunEventInput,
} from "@/lib/db/execution-runs"
import type { RunEvent } from "@/types/execution/run"
import type { RunActivityCategory } from "@/types/execution/run"
import {
  sanitizeActivityLabel,
  safeToolActivityMetadata,
  type SafeToolActivityMetadata,
} from "@/lib/execution/run-activity"
import {
  detectVerificationRunner,
  type VerificationRunner,
} from "@/lib/execution/verification/detect"
import { parseVerificationOutput } from "@/lib/execution/verification/parse"

type Append = (runId: string, input: AppendRunEventInput) => Promise<RunEvent>

function safeToolSummary(category: RunActivityCategory): {
  running: string
  completed: string
} {
  switch (category) {
    case "search":
      return { running: "Searching documents", completed: "Search completed" }
    case "read":
      return { running: "Reading files", completed: "Files reviewed" }
    case "write":
      return { running: "Updating files", completed: "Files updated" }
    case "command":
      return { running: "Running a command", completed: "Command completed" }
    case "skill":
      return { running: "Using a skill", completed: "Skill completed" }
    default:
      return { running: "Using an integration", completed: "Integration completed" }
  }
}

export interface AgentRunEventProducerOptions {
  /** Absolute root used only to prove that a tool path is safe to make relative. */
  workspaceRoot?: string
}

/** Ceiling on test-runner tool calls awaiting a result. See the field's docblock. */
const MAX_PENDING_VERIFICATIONS = 64

/** Capture-stream adapter that emits summaries only and drops reasoning/raw data. */
export class AgentRunEventProducer {
  private readonly runId: string
  private readonly append: Append
  private anonymousToolCounter = 0
  private readonly stepByToolCall = new Map<string, string>()
  private readonly metadataByToolCall = new Map<string, SafeToolActivityMetadata>()
  /**
   * Only the RUNNER enum is remembered, never the command that produced it.
   * Detection happens at `tool-call`, where the arguments are reliably present;
   * keeping the command around until the result arrived would park a string
   * that can carry paths, env assignments, and tokens on the producer.
   *
   * Bounded: the only removal is the matching `tool-result`, and a call whose
   * result never arrives (an aborted turn, a dead sidecar) would otherwise hold
   * its entry for the producer's lifetime under an id that never repeats.
   */
  private readonly verificationByToolCall = new Map<string, VerificationRunner>()
  private readonly commentaryByMessage = new Map<string, string>()
  private readonly startedCommentary = new Set<string>()
  private pending: Promise<void> = Promise.resolve()

  constructor(
    runId: string,
    append: Append = runEventJournal.append.bind(runEventJournal),
    private readonly options: AgentRunEventProducerOptions = {}
  ) {
    this.runId = runId
    this.append = append
  }

  async start(ts: number = Date.now(), payload: Record<string, unknown> = {}): Promise<void> {
    await this.append(this.runId, semanticRunEvent("run.started", payload, { ts }))
  }

  async onCaptureEvent(event: CaptureStreamEvent, ts: number = Date.now()): Promise<void> {
    const next = this.pending.then(() => this.processCaptureEvent(event, ts))
    this.pending = next.catch(() => undefined)
    return next
  }

  private async processCaptureEvent(event: CaptureStreamEvent, ts: number): Promise<void> {
    if (event.type === "thinking-delta" || event.type === "text-delta") return
    if (event.type === "usage" || event.type === "compact") return

    if (event.type === "commentary-delta") {
      const messageId = event.messageId ?? "current"
      const stepId = `commentary:${messageId}`
      const accumulated = `${this.commentaryByMessage.get(messageId) ?? ""}${event.delta}`
      this.commentaryByMessage.set(messageId, accumulated)
      const title = sanitizeActivityLabel(accumulated, "Agent progress")
      if (!title) return

      if (!this.startedCommentary.has(messageId)) {
        this.startedCommentary.add(messageId)
        const payload = { stepId, title, safeTitle: true, category: "status" }
        await this.append(this.runId, semanticRunEvent("step.added", payload, { ts }))
        await this.append(this.runId, semanticRunEvent("step.started", payload, { ts }))
      }
      if (event.done) {
        await this.append(
          this.runId,
          semanticRunEvent(
            "step.progress",
            { stepId, title, safeTitle: true, category: "status" },
            { ts }
          )
        )
      }
      return
    }

    if (event.type === "tool-call") {
      const toolCallId = event.id ?? `anonymous-${++this.anonymousToolCounter}`
      const stepId = `tool:${toolCallId}`
      const metadata = safeToolActivityMetadata(event.toolName, event.input, this.options)
      const summary = safeToolSummary(metadata.category)
      const label = summary.running
      this.stepByToolCall.set(toolCallId, stepId)
      this.metadataByToolCall.set(toolCallId, metadata)
      await this.append(
        this.runId,
        semanticRunEvent("step.added", { stepId, title: label, safeTitle: true }, { ts })
      )
      await this.append(
        this.runId,
        semanticRunEvent("step.started", { stepId, title: label, safeTitle: true }, { ts })
      )
      const verificationRunner = detectVerificationRunner(event.toolName, event.input)
      if (verificationRunner) {
        // Evict oldest-first once the cap is reached. A turn never has this
        // many test runs in flight at once, so an entry old enough to be
        // evicted is one whose result is never coming.
        if (this.verificationByToolCall.size >= MAX_PENDING_VERIFICATIONS) {
          const oldest = this.verificationByToolCall.keys().next()
          if (!oldest.done) this.verificationByToolCall.delete(oldest.value)
        }
        this.verificationByToolCall.set(toolCallId, verificationRunner)
      }
      await this.append(
        this.runId,
        semanticRunEvent(
          "tool.started",
          {
            toolCallId,
            toolName: metadata.toolName,
            category: metadata.category,
            summary: summary.running,
            ...(metadata.target ? { target: metadata.target } : {}),
          },
          { ts }
        )
      )
      return
    }

    if (event.type === "tool-result") {
      const toolCallId = event.id ?? `anonymous-result-${++this.anonymousToolCounter}`
      const stepId = this.stepByToolCall.get(toolCallId) ?? `tool:${toolCallId}`
      const metadata =
        this.metadataByToolCall.get(toolCallId) ?? safeToolActivityMetadata(event.toolName)
      const summary = safeToolSummary(metadata.category)
      const label = summary.running
      const failed = event.isError === true
      await this.append(
        this.runId,
        semanticRunEvent(
          failed ? "tool.failed" : "tool.completed",
          {
            toolCallId,
            toolName: metadata.toolName,
            category: metadata.category,
            summary: failed ? "Tool failed" : summary.completed,
            ...(metadata.target ? { target: metadata.target } : {}),
          },
          { ts }
        )
      )
      await this.append(
        this.runId,
        semanticRunEvent(
          failed ? "step.failed" : "step.completed",
          {
            stepId,
            title: label,
            summary: failed ? "Tool failed" : summary.completed,
            safeTitle: true,
            safeSummary: true,
          },
          { ts }
        )
      )
      await this.emitVerificationArtifact(toolCallId, event, ts)
    }
  }

  /**
   * Project a test run's COUNTS onto the run, when this tool call was one.
   *
   * The title is a caller-declared safe constant rather than anything derived
   * from the command, and the output itself never enters the journal — the
   * transcript already owns it, and `detailsRef` points back at the tool call
   * for anyone who needs the real thing.
   */
  private async emitVerificationArtifact(
    toolCallId: string,
    event: Extract<CaptureStreamEvent, { type: "tool-result" }>,
    ts: number
  ): Promise<void> {
    const runner =
      this.verificationByToolCall.get(toolCallId) ??
      detectVerificationRunner(event.toolName, event.input)
    // One artifact per call, even if a result is delivered twice.
    this.verificationByToolCall.delete(toolCallId)
    if (!runner) return

    const verification = parseVerificationOutput(runner, event.result)
    await this.append(
      this.runId,
      semanticRunEvent(
        "artifact.created",
        {
          artifactId: `verification:${toolCallId}`,
          title: "Tests",
          safeTitle: true,
          kind: "verification",
          detailsRef: toolCallId,
          verification,
        },
        { ts }
      )
    )
  }

  /**
   * Record that the run degraded to a lesser rail than requested (ADR-0090
   * Phase 6) — e.g. `"sidecar-unavailable"` / `"legacy-completion-fallback"`.
   * Machine-readable reason only; presenters own the user-facing copy.
   *
   * INTENTIONALLY DORMANT: the sole current producer site (connector runtime)
   * runs the sidecar rail and has no degradation signal yet; callers with a
   * `degradedReason` (service results) wire in with Phase 7 run surfacing.
   * Pinned by source-mappers.test.ts.
   */
  async degraded(reason: string, ts: number = Date.now()): Promise<void> {
    await this.append(this.runId, semanticRunEvent("run.degraded", { reason }, { ts }))
  }

  async finish(
    status: "completed" | "failed" | "cancelled",
    ts: number = Date.now(),
    summary?: string
  ): Promise<void> {
    await this.pending
    const type =
      status === "completed"
        ? "run.completed"
        : status === "failed"
          ? "run.failed"
          : "run.cancelled"
    const payload =
      status === "failed" ? { error: summary ?? "Run failed" } : summary ? { summary } : {}
    await this.append(this.runId, semanticRunEvent(type, payload, { ts }))
  }
}
