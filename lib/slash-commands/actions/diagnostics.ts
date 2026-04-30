// Action handlers for diagnostics slash commands (/status, /cost). The handler
// signature matches `SlashCommand.handler` from `../builtin.ts`.

import type { SlashContext } from "../builtin"
import { getSidecarStatus, hasApiKey } from "@/lib/claude/ipc"
import { getSession } from "@/lib/db/sessions"
import { listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { UsageInfo } from "@/lib/claude/adapter"

/**
 * Render the active session's effective config + sidecar / API key health as
 * a markdown system message. Falls back gracefully when nothing is selected.
 */
export async function handleStatus(ctx: SlashContext): Promise<void> {
  const sessionId = ctx.activeSessionId
  const lines: string[] = ["**Status**", ""]

  // Sidecar + API key + workspace MCP count run in parallel.
  const [sidecarStatus, apiKeySet, mcpServers] = await Promise.all([
    getSidecarStatus().catch(() => null),
    hasApiKey().catch(() => false),
    listEnabledMcpServers().catch(() => []),
  ])

  if (!sessionId) {
    lines.push("- No active session.")
  } else {
    try {
      const session = (await getSession(sessionId)) ?? null
      const appSettings = useSettingsStore.getState().settings ?? null
      const referencedPaths = useChatStore
        .getState()
        .referencedPaths.map((r) => ({ absolute: r.absolute, isDir: r.isDir }))
      const opts = await resolveSendOptions({
        session,
        appSettings,
        referencedPaths,
      })
      lines.push(`- **Session**: ${session?.title ?? "(unknown)"} (\`${sessionId}\`)`)
      lines.push(`- **Model**: ${opts.model ?? "(SDK default)"}`)
      lines.push(
        `- **Permission mode**: ${opts.permissionMode ?? "default"}` +
          (ctx.currentPermissionMode ? " (overridden by composer)" : "")
      )
      lines.push(`- **Working dir**: ${opts.cwd ?? "(default)"}`)
      const dirCount = opts.additionalDirectories?.length ?? 0
      if (dirCount > 0) {
        lines.push(`- **Additional dirs**: ${dirCount}`)
      }
      const allowed = opts.allowedTools?.length ?? 0
      if (allowed > 0) {
        lines.push(`- **Allowed tools**: ${allowed}`)
      }
      if (session?.sdkSessionId) {
        lines.push(
          `- **SDK conversation**: \`${session.sdkSessionId.slice(0, 12)}…\` (resume on next send)`
        )
      }
    } catch (err) {
      lines.push(
        `- Could not resolve session config: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  lines.push("")
  lines.push("**Runtime**")
  lines.push(`- Sidecar: ${sidecarStatus?.ready ? "ready" : "not ready"}`)
  lines.push(`- API key: ${apiKeySet ? "set" : "not set"}`)
  lines.push(
    `- MCP servers enabled: ${mcpServers.length}` +
      (mcpServers.length > 0 ? ` (${mcpServers.map((s) => s.name).join(", ")})` : "")
  )

  ctx.pushSystemMessage(lines.join("\n"))
}

/**
 * Aggregate usage + cost numbers from the active session's assistant messages.
 * Reads straight from the chat store so the totals match what the user sees.
 */
export async function handleCost(ctx: SlashContext): Promise<void> {
  const sessionId = ctx.activeSessionId
  if (!sessionId) {
    ctx.pushSystemMessage("No active session.")
    return
  }
  const messages = useChatStore.getState().messages
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreationTokens = 0
  let cacheReadTokens = 0
  let totalCostUsd = 0
  let durationMs = 0
  let assistantTurnCount = 0
  let usageHits = 0

  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    assistantTurnCount += 1
    const meta = msg.metadata as { usage?: UsageInfo } | undefined
    const usage = meta?.usage
    if (!usage) continue
    usageHits += 1
    inputTokens += usage.inputTokens ?? 0
    outputTokens += usage.outputTokens ?? 0
    cacheCreationTokens += usage.cacheCreationInputTokens ?? 0
    cacheReadTokens += usage.cacheReadInputTokens ?? 0
    totalCostUsd += usage.totalCostUsd ?? 0
    durationMs += usage.durationMs ?? 0
  }

  const lines: string[] = ["**Cost & usage**", ""]
  if (assistantTurnCount === 0) {
    lines.push("- No assistant turns yet in this session.")
    ctx.pushSystemMessage(lines.join("\n"))
    return
  }
  if (usageHits === 0) {
    lines.push("- No usage metrics recorded yet (turn still streaming?).")
    ctx.pushSystemMessage(lines.join("\n"))
    return
  }
  lines.push(`- **Turns**: ${assistantTurnCount} assistant (${usageHits} with metrics)`)
  lines.push(`- **Input tokens**: ${inputTokens.toLocaleString()}`)
  lines.push(`- **Output tokens**: ${outputTokens.toLocaleString()}`)
  if (cacheCreationTokens > 0 || cacheReadTokens > 0) {
    lines.push(
      `- **Cache**: write ${cacheCreationTokens.toLocaleString()} / read ${cacheReadTokens.toLocaleString()}`
    )
  }
  if (totalCostUsd > 0) {
    lines.push(`- **Cost**: $${totalCostUsd.toFixed(4)} USD`)
  }
  if (durationMs > 0) {
    lines.push(`- **Duration**: ${(durationMs / 1000).toFixed(1)}s`)
  }
  ctx.pushSystemMessage(lines.join("\n"))
}
