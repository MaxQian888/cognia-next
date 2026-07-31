// Notification action registry (ADR-0042). Notification actions persist to
// Dexie, so they can't carry closures — they reference a registered `command`
// key resolved here at click time. Mirrors the existing plugin
// `onAction(id, action: string)` string-command convention.

import { loggers } from "@cognia/logging"

const log = loggers.ui

export interface NotificationActionContext {
  notificationId: string
  command: string
  args?: Record<string, unknown>
}

export type NotificationCommandHandler = (ctx: NotificationActionContext) => void | Promise<void>

const handlers = new Map<string, NotificationCommandHandler>()

/** Register a command handler. Returns an unregister function. */
export function registerNotificationCommand(
  command: string,
  handler: NotificationCommandHandler
): () => void {
  handlers.set(command, handler)
  return () => {
    if (handlers.get(command) === handler) handlers.delete(command)
  }
}

export function hasNotificationCommand(command: string): boolean {
  return handlers.has(command)
}

/** Dispatch a registered command. Unknown commands are logged, not thrown. */
export async function dispatchNotificationCommand(ctx: NotificationActionContext): Promise<void> {
  const handler = handlers.get(ctx.command)
  if (!handler) {
    log.warn("notification command has no handler", { command: ctx.command })
    return
  }
  try {
    await handler(ctx)
  } catch (err) {
    log.error("notification command handler threw", {
      command: ctx.command,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Test-only: clear all registered handlers. */
export function __resetNotificationCommandsForTesting(): void {
  handlers.clear()
}
