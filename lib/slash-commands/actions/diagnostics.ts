// Action handlers for diagnostics slash commands (/status, /cost, /doctor,
// /context). The handler signature matches `SlashCommand.handler` from
// `../builtin.ts`.

import type { SlashContext } from "../builtin"
import { getSidecarStatus, hasApiKey, hasOauthBearer } from "@/lib/claude/ipc"
import { getSession } from "@/lib/db/sessions"
import { listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { UsageInfo } from "@/lib/claude/adapter"
import {
  AUTO_COMPACT_FRACTION,
  computeContextWindowUsage,
  getLatestUsage,
} from "@/lib/claude/usage"
import type { UIMessage } from "ai"
import { isTauri } from "@/lib/tauri"

/**
 * Best-effort resolve of the model id driving the active session: per-session
 * override first, then the app default. Used by `/context` and `/cost` to size
 * the context window. Never throws — falls back to `undefined` (→ 200k window).
 */
async function resolveActiveModel(activeSessionId: string | null): Promise<string | undefined> {
  let model: string | undefined
  if (activeSessionId) {
    try {
      const session = await getSession(activeSessionId)
      model = session?.model
    } catch {
      // ignore — fall through to the app default
    }
  }
  return model ?? useSettingsStore.getState().settings?.defaultModel ?? undefined
}

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

  // Context-window occupancy of the latest turn (not the cumulative sum).
  const latest = getLatestUsage(messages as UIMessage[])
  const model = await resolveActiveModel(ctx.activeSessionId)
  const win = computeContextWindowUsage(latest, model)
  lines.push(
    `- **Context window**: ${win.used.toLocaleString()} / ${win.max.toLocaleString()} ` +
      `(${(win.fraction * 100).toFixed(1)}% used)`
  )

  ctx.pushSystemMessage(lines.join("\n"))
}

/**
 * Comprehensive runtime check — sidecar / auth / MCP / desktop vs. web. This
 * is the cognia-next equivalent of Claude Code's `/doctor`: a single command
 * a user can run when something feels wrong. Every probe is best-effort so
 * a single failing read doesn't hide the rest of the report.
 */
export async function handleDoctor(ctx: SlashContext): Promise<void> {
  const lines: string[] = ["**Doctor**", ""]

  const [sidecarStatus, apiKeySet, oauthSet, mcpServers] = await Promise.all([
    getSidecarStatus().catch(() => null),
    hasApiKey().catch(() => false),
    hasOauthBearer().catch(() => false),
    listEnabledMcpServers().catch(() => []),
  ])

  lines.push("**Runtime**")
  lines.push(`- Mode: ${isTauri() ? "Tauri desktop" : "Web (browser)"}`)
  lines.push(`- Sidecar: ${sidecarStatus?.ready ? "ready" : "not ready"}`)
  lines.push("")

  lines.push("**Authentication**")
  if (oauthSet) {
    lines.push("- Claude OAuth bearer: present (Pro/Max subscription path)")
  } else if (apiKeySet) {
    lines.push("- Anthropic API key: present (legacy path)")
  } else {
    lines.push("- ⚠ No credentials. Add an API key or sign in to a subscription.")
  }
  lines.push("")

  const settings = useSettingsStore.getState().settings
  lines.push("**Defaults**")
  lines.push(`- Default model: ${settings?.defaultModel ?? "(SDK default)"}`)
  lines.push(`- Permission mode: ${settings?.permissionMode ?? "default"}`)
  lines.push(`- Working dir: ${settings?.defaultWorkingDir ?? "(none)"}`)
  if (settings?.defaultMaxThinkingTokens) {
    lines.push(`- Thinking budget: ${settings.defaultMaxThinkingTokens} tokens`)
  } else {
    lines.push("- Thinking budget: disabled")
  }
  lines.push("")

  lines.push("**MCP**")
  if (mcpServers.length === 0) {
    lines.push("- No enabled MCP servers.")
  } else {
    for (const s of mcpServers) {
      lines.push(`- \`${s.name}\` (${s.transport})`)
    }
  }
  lines.push("")

  if (!isTauri()) {
    lines.push("ℹ Several runtime probes (keyring, file-system reads) require the desktop build.")
  } else {
    lines.push("ℹ Open Settings → Agent runtime → Sidecar to restart the SDK process.")
  }

  ctx.pushSystemMessage(lines.join("\n"))
}

/**
 * Local-context summary — counts the in-memory message buffer + accumulated
 * token usage. cognia-next runs the SDK headless, so the SDK's own
 * `/context` panel isn't available; this hands the user the same data we
 * have client-side.
 */
export async function handleContext(ctx: SlashContext): Promise<void> {
  const messages = useChatStore.getState().messages
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let userTurns = 0
  let assistantTurns = 0
  for (const msg of messages) {
    if (msg.role === "user") userTurns += 1
    if (msg.role === "assistant") {
      assistantTurns += 1
      const meta = msg.metadata as { usage?: UsageInfo } | undefined
      const usage = meta?.usage
      if (!usage) continue
      inputTokens += usage.inputTokens ?? 0
      outputTokens += usage.outputTokens ?? 0
      cacheReadTokens += usage.cacheReadInputTokens ?? 0
      cacheCreationTokens += usage.cacheCreationInputTokens ?? 0
    }
  }

  const lines: string[] = ["**Context**", ""]
  lines.push(`- Messages: ${userTurns} user · ${assistantTurns} assistant`)
  if (assistantTurns === 0) {
    lines.push("- No usage metrics yet — context window is fresh.")
    ctx.pushSystemMessage(lines.join("\n"))
    return
  }
  const totalIn = inputTokens + cacheReadTokens + cacheCreationTokens
  lines.push(`- Input tokens (incl. cache): ${totalIn.toLocaleString()}`)
  lines.push(`- Output tokens: ${outputTokens.toLocaleString()}`)
  if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
    lines.push(
      `- Cache hits: write ${cacheCreationTokens.toLocaleString()} / read ${cacheReadTokens.toLocaleString()}`
    )
  }

  // Window occupancy is the *latest* turn against the model's context window
  // (matches the composer indicator) — distinct from the cumulative totals above.
  const latest = getLatestUsage(messages as UIMessage[])
  const model = await resolveActiveModel(ctx.activeSessionId)
  const win = computeContextWindowUsage(latest, model)
  lines.push(
    `- **Window**: ${win.used.toLocaleString()} / ${win.max.toLocaleString()} ` +
      `(${(win.fraction * 100).toFixed(1)}% used, ${win.remaining.toLocaleString()} left)`
  )
  lines.push(
    `- **Auto-compact at**: ${(AUTO_COMPACT_FRACTION * 100).toFixed(1)}% ` +
      `(~${win.compactThresholdTokens.toLocaleString()} tokens)`
  )

  lines.push("", "Run `/compact` to ask the SDK to summarise older turns and free up the window.")
  ctx.pushSystemMessage(lines.join("\n"))
}
