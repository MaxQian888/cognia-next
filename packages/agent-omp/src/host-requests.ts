/** Correlated host callbacks and extension dialogs. No application imports. */
import type {
  AcpElicitationResponse,
  ExternalAgentEvent,
} from "@cognia/agent-contracts/external-agent"
import { mapOmpRpcEvent } from "./rpc-events"
import type {
  AskAnswer,
  ExtensionUiRequest,
  ExtensionUiResponse,
  HostToolCallRequest,
  HostToolResultPayload,
  HostUriRequest,
  HostUriResult,
  OmpServerFrame,
  RpcInbound,
} from "./wire"

export interface OmpHostRequestsOptions {
  sessionId: string
  /** Distinguishes native session generations inside one adapter session. */
  requestScope?: string
  send(frame: RpcInbound): Promise<void>
  emit(event: ExternalAgentEvent): void
  fatal(error: Error): void
  /** Host is responsible for authorization and PII before returning/streaming results. */
  tool?(
    request: HostToolCallRequest,
    signal: AbortSignal,
    update: (result: HostToolResultPayload) => Promise<void>
  ): Promise<HostToolResultPayload>
  uri?(request: HostUriRequest, signal: AbortSignal): Promise<Omit<HostUriResult, "id" | "type">>
  timeoutMs?: number
}
type Dialog = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" }
>
interface PendingOperation {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}
interface PendingDialog {
  frame: Dialog
  scopedId: string
  timer: ReturnType<typeof setTimeout>
}
const FAILED = "OMP host operation failed or was denied"

export class OmpHostRequests {
  private disposed = false
  private operations = new Map<string, PendingOperation>()
  private dialogs = new Map<string, PendingDialog>()
  private timeout: number
  constructor(private options: OmpHostRequestsOptions) {
    this.timeout = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1)
      throw new Error("OMP host timeout must be a positive integer")
  }

  handle(frame: OmpServerFrame): boolean {
    if (this.disposed) return false
    switch (frame.type) {
      case "host_tool_call":
        this.startOperation(frame, "tool")
        return true
      case "host_uri_request":
        this.startOperation(frame, "uri")
        return true
      case "host_tool_cancel":
        this.cancelOperation(`tool:${frame.targetId}`)
        return true
      case "host_uri_cancel":
        this.cancelOperation(`uri:${frame.targetId}`)
        return true
      case "extension_ui_request": {
        if (frame.method === "cancel") {
          this.closeDialog(frame.targetId)
          return true
        }
        if (!["select", "confirm", "input", "editor", "ask"].includes(frame.method)) return false
        const dialog = frame as Dialog
        if (this.dialogs.has(dialog.id)) {
          this.fail("Duplicate OMP dialog request id")
          return true
        }
        const scope = this.options.requestScope
        const scopedId = `${encodeURIComponent(this.options.sessionId)}:omp:${scope === undefined ? "" : `${encodeURIComponent(scope)}:`}${encodeURIComponent(dialog.id)}`
        const requestTimeout =
          "timeout" in dialog &&
          typeof dialog.timeout === "number" &&
          Number.isFinite(dialog.timeout) &&
          dialog.timeout > 0
            ? Math.min(dialog.timeout, this.timeout)
            : this.timeout
        const timer = setTimeout(() => {
          if (!this.dialogs.has(dialog.id) || this.disposed) return
          this.closeDialog(dialog.id)
          void this.send({
            type: "extension_ui_response",
            id: dialog.id,
            cancelled: true,
            timedOut: true,
          }).catch(() => {})
        }, requestTimeout)
        this.dialogs.set(dialog.id, { frame: dialog, scopedId, timer })
        for (const event of mapOmpRpcEvent(
          { ...dialog, id: scopedId },
          { sessionId: this.options.sessionId }
        ))
          this.options.emit(event)
        return true
      }
      default:
        return false
    }
  }

  async respond(response: AcpElicitationResponse): Promise<void> {
    if (this.disposed) throw new Error("OMP host requests are disposed")
    const pending = [...this.dialogs.values()].find(
      (value) => value.scopedId === response.requestId
    )
    if (!pending) throw new Error("Unknown or expired OMP dialog")
    const reply = this.dialogReply(pending.frame, response)
    // Consume before awaiting transport so two responders cannot answer the same native id.
    this.closeDialog(pending.frame.id)
    await this.send(reply)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const key of this.operations.keys()) this.cancelOperation(key)
    for (const id of this.dialogs.keys()) this.closeDialog(id)
  }

  private startOperation(frame: HostToolCallRequest | HostUriRequest, kind: "tool" | "uri"): void {
    const key = `${kind}:${frame.id}`
    if (this.operations.has(key)) {
      this.fail("Duplicate OMP host request id")
      return
    }
    const controller = new AbortController()
    const operation: PendingOperation = {
      controller,
      timer: setTimeout(() => {
        if (this.operations.get(key) !== operation) return
        this.cancelOperation(key)
        void this.send(this.failure(frame)).catch(() => {})
      }, this.timeout),
    }
    this.operations.set(key, operation)
    void (async () => {
      let result: RpcInbound
      try {
        if (frame.type === "host_tool_call") {
          if (!this.options.tool) throw new Error(FAILED)
          const output = await this.options.tool(
            frame,
            controller.signal,
            async (partialResult) => {
              if (this.disposed || this.operations.get(key) !== operation) return
              if (!validToolResult(partialResult)) throw new Error(FAILED)
              await this.send({ type: "host_tool_update", id: frame.id, partialResult })
            }
          )
          if (!validToolResult(output)) throw new Error(FAILED)
          result = {
            type: "host_tool_result",
            id: frame.id,
            result: output,
            ...(output.isError === true ? { isError: true } : {}),
          }
        } else {
          if (!this.options.uri) throw new Error(FAILED)
          const output = await this.options.uri(frame, controller.signal)
          if (
            !output ||
            (frame.operation === "read" &&
              output.isError !== true &&
              typeof output.content !== "string")
          )
            throw new Error(FAILED)
          // Set correlation fields last so a JS callback cannot replace the native id/type.
          result = { ...output, type: "host_uri_result", id: frame.id }
        }
      } catch {
        result = this.failure(frame)
      }
      if (this.disposed || this.operations.get(key) !== operation) return
      this.cancelOperation(key)
      await this.send(result)
    })().catch(() => {})
  }

  private failure(frame: HostToolCallRequest | HostUriRequest): RpcInbound {
    return frame.type === "host_tool_call"
      ? {
          type: "host_tool_result",
          id: frame.id,
          isError: true,
          result: { content: [{ type: "text", text: FAILED }], isError: true },
        }
      : { type: "host_uri_result", id: frame.id, isError: true, error: FAILED }
  }
  private cancelOperation(key: string): void {
    const value = this.operations.get(key)
    if (!value) return
    this.operations.delete(key)
    clearTimeout(value.timer)
    value.controller.abort()
  }
  private closeDialog(id: string): void {
    const value = this.dialogs.get(id)
    if (!value) return
    this.dialogs.delete(id)
    clearTimeout(value.timer)
    this.options.emit({
      type: "elicitation_complete",
      sessionId: this.options.sessionId,
      timestamp: new Date(),
      elicitationId: value.scopedId,
    })
  }
  private async send(frame: RpcInbound): Promise<void> {
    if (this.disposed) return
    try {
      await this.options.send(frame)
    } catch {
      this.fail("OMP host response transport failed")
      throw new Error("OMP host response transport failed")
    }
  }
  private fail(message: string): void {
    this.dispose()
    this.options.fatal(new Error(message))
  }

  private dialogReply(frame: Dialog, response: AcpElicitationResponse): ExtensionUiResponse {
    const base = { type: "extension_ui_response" as const, id: frame.id }
    if (response.action === "decline" || response.action === "cancel")
      return { ...base, cancelled: true }
    if (response.action !== "accept") throw new Error("Invalid OMP dialog action")
    const values = response.content ?? {}
    if (frame.method === "confirm") {
      if (typeof values.confirm !== "boolean")
        throw new Error("OMP confirmation requires a boolean")
      return { ...base, confirmed: values.confirm }
    }
    if (frame.method === "ask") {
      const answers: AskAnswer[] = frame.questions.map((question) => {
        const choice = values[question.id]
        const selectedOptions =
          choice === undefined || choice === ""
            ? []
            : typeof choice === "string"
              ? [choice]
              : Array.isArray(choice) && choice.every((v) => typeof v === "string")
                ? choice
                : undefined
        if (
          !selectedOptions ||
          new Set(selectedOptions).size !== selectedOptions.length ||
          selectedOptions.some((option) => !question.options.some((o) => o.label === option))
        )
          throw new Error("Invalid OMP question selection")
        const custom = values[`${question.id}:customInput`]
        if (custom !== undefined && typeof custom !== "string")
          throw new Error("OMP custom answer must be text")
        const customInput = typeof custom === "string" ? custom.trim() : ""
        if (
          !question.multi &&
          (selectedOptions.length > 1 || (selectedOptions.length > 0 && customInput.length > 0))
        )
          throw new Error("OMP single selection accepts one answer")
        if (!question.multi && selectedOptions.length === 0 && !customInput)
          throw new Error("OMP question requires an answer")
        return { id: question.id, selectedOptions, ...(customInput ? { customInput } : {}) }
      })
      return { ...base, answers }
    }
    const value = values[frame.method]
    if (typeof value !== "string") throw new Error("OMP dialog requires a text answer")
    if (frame.method === "select" && !frame.options.includes(value))
      throw new Error("Invalid OMP select answer")
    return { ...base, value }
  }
}
function validToolResult(value: unknown): value is HostToolResultPayload {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content))
    return false
  return value.content.every((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false
    return (
      (block.type === "text" && "text" in block && typeof block.text === "string") ||
      (block.type === "image" &&
        "data" in block &&
        typeof block.data === "string" &&
        "mimeType" in block &&
        typeof block.mimeType === "string")
    )
  })
}
