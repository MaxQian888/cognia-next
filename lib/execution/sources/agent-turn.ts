import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import {
  runEventJournal,
  semanticRunEvent,
  type AppendRunEventInput,
} from "@/lib/db/execution-runs"
import type { RunEvent } from "@/types/execution/run"

type Append = (runId: string, input: AppendRunEventInput) => Promise<RunEvent>

function safeToolSummary(toolName: string): {
  category: string
  running: string
  completed: string
} {
  const value = toolName.toLowerCase()
  if (/search|browse|web/.test(value)) {
    return { category: "search", running: "Searching documents", completed: "Search completed" }
  }
  if (/read|list|find|open/.test(value)) {
    return { category: "read", running: "Reading files", completed: "Files reviewed" }
  }
  if (/write|edit|patch|replace/.test(value)) {
    return { category: "write", running: "Updating files", completed: "Files updated" }
  }
  if (/bash|shell|exec|command|terminal/.test(value)) {
    return { category: "command", running: "Running a command", completed: "Command completed" }
  }
  return {
    category: "integration",
    running: "Using an integration",
    completed: "Integration completed",
  }
}

/** Capture-stream adapter that emits summaries only and drops reasoning/raw data. */
export class AgentRunEventProducer {
  private readonly runId: string
  private readonly append: Append
  private anonymousToolCounter = 0
  private readonly stepByToolCall = new Map<string, string>()
  private pending: Promise<void> = Promise.resolve()

  constructor(runId: string, append: Append = runEventJournal.append.bind(runEventJournal)) {
    this.runId = runId
    this.append = append
  }

  async start(ts: number = Date.now()): Promise<void> {
    await this.append(this.runId, semanticRunEvent("run.started", {}, { ts }))
  }

  async onCaptureEvent(event: CaptureStreamEvent, ts: number = Date.now()): Promise<void> {
    const next = this.pending.then(() => this.processCaptureEvent(event, ts))
    this.pending = next.catch(() => undefined)
    return next
  }

  private async processCaptureEvent(event: CaptureStreamEvent, ts: number): Promise<void> {
    if (event.type === "thinking-delta" || event.type === "text-delta") return
    if (event.type === "usage" || event.type === "compact") return

    if (event.type === "tool-call") {
      const toolCallId = event.id ?? `anonymous-${++this.anonymousToolCounter}`
      const stepId = `tool:${toolCallId}`
      const summary = safeToolSummary(event.toolName)
      const label = summary.running
      this.stepByToolCall.set(toolCallId, stepId)
      await this.append(
        this.runId,
        semanticRunEvent("step.added", { stepId, title: label }, { ts })
      )
      await this.append(
        this.runId,
        semanticRunEvent("step.started", { stepId, title: label }, { ts })
      )
      await this.append(
        this.runId,
        semanticRunEvent(
          "tool.started",
          { toolCallId, toolName: summary.category, summary: summary.running },
          { ts }
        )
      )
      return
    }

    if (event.type === "tool-result") {
      const toolCallId = event.id ?? `anonymous-result-${++this.anonymousToolCounter}`
      const stepId = this.stepByToolCall.get(toolCallId) ?? `tool:${toolCallId}`
      const summary = safeToolSummary(event.toolName)
      const label = summary.running
      const failed = event.isError === true
      await this.append(
        this.runId,
        semanticRunEvent(
          failed ? "tool.failed" : "tool.completed",
          {
            toolCallId,
            toolName: summary.category,
            summary: failed ? "Tool failed" : summary.completed,
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
          },
          { ts }
        )
      )
    }
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
