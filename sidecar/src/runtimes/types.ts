import type { Prompt, SendOptions } from "../shared/wire/inbound.ts"
import type { HostRpcCaller } from "../tools/state/host-background-shells.ts"

/** Shared input contract for the two in-process runtime rails. */
export interface DispatchParams {
  sessionId: string
  firstPrompt: Prompt
  sendOptions: SendOptions
  emit(event: Record<string, unknown>): void
  log(level: string, message: string): void
  hostRpc?: HostRpcCaller | null
}
