import type { SendOptions, Prompt } from "../../shared/wire/inbound.ts"
export type Log = (level: "info" | "warn" | "error", message: string) => void
export type Frame = { type: string; sessionId?: string; turnId?: string; [key: string]: unknown }
export type Emit = (frame: Frame) => void
export type Outcome = { ok: true; result: unknown } | { ok: false; error: string }
/** The host consumes capabilities, while each rail owns its complete session. */
export interface HostSession {
  multiTurn?: boolean
  runtimeAdapterId?: string
  turnRef?: { id?: string }
  sendOptions?: SendOptions
  modeTransition?: Promise<Outcome>
  q?: {
    active?: unknown
    interrupt?(): unknown
    close?(): void
    setPermissionMode?(mode: string): unknown
  }
  pushUserMessage?(prompt: Prompt, priority?: string): unknown
  setNextTurnLedger?(ledger: unknown): void
  closeInput?(): void
  drainPending?(reason: string): void
  restoreConversation?(messages: unknown): unknown
  scheduleSteerInputClose?(): void
  resolveCallReserve?(message: unknown): unknown
  requestCompact?(focus?: unknown): unknown
  pendingApprovals?: Map<
    string,
    {
      resolve(value: unknown): void
      input?: unknown
      suggestions?: unknown
      suppressAlwaysAllowRule?: unknown
    }
  >
  pendingPluginToolCalls?: Map<string, { resolve(value: unknown): void }>
  pendingPluginHookCalls?: Map<string, { resolve(value: unknown): void }>
  pendingToolResultReviews?: Map<string, { resolve(value: unknown): void }>
  pendingProtocolExecs?: Map<
    string,
    { push(value: unknown): void; finish(value: unknown): void; fail(value: unknown): void }
  >
}
