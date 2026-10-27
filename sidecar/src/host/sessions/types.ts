import type { SendOptions, Prompt } from "../../shared/wire/inbound.ts"
import type {
  AgentExtensionReloadOptions,
  AgentExtensionReloadResult,
} from "@cognia/agent-contracts/session-operations"
export type Log = (level: "info" | "warn" | "error", message: string) => void
export type Frame = { type: string; sessionId?: string; turnId?: string; [key: string]: unknown }
export type Emit = (frame: Frame) => void
export type Outcome = { ok: true; result: unknown } | { ok: false; error: string }
/** The host consumes capabilities, while each rail owns its complete session. */
export interface HostSession {
  reloadExtensions?(options?: AgentExtensionReloadOptions): Promise<AgentExtensionReloadResult>
  sdkSessionId?: string
  multiTurn?: boolean
  /** Resolves after the runtime loop and its owned processes are disposed. */
  closed?: Promise<void>
  runtimeAdapterId?: string
  turnRef?: { id?: string }
  /** Prompt admitted but possibly still waiting for the runtime's input consumer. */
  turnPending?: boolean
  sendOptions?: SendOptions
  modeTransition?: Promise<Outcome>
  q?: {
    active?: unknown
    closed?: boolean
    interrupt?(): unknown
    close?(): void
    setModel?(model: string): unknown
    setPermissionMode?(mode: string): unknown
  }
  pushUserMessage?(prompt: Prompt, priority?: string): unknown
  setNextTurnLedger?(ledger: unknown, remoteExecutionContext?: unknown): void
  setNextTurnVerificationBudget?(stamp: SendOptions["verificationBudget"]): void
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
      requiresExplicitConsent?: boolean
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
