/**
 * The plugin contract's share of `stores/chat/chat-store.ts`, which re-exports these.
 */
import type { SendOptions } from "@cognia/agent-config-types"

export type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

export type PermissionMode = NonNullable<SendOptions["permissionMode"]>
