// Action handlers for session-management slash commands.
// Each function matches the SlashCommand `handler` signature and is wired into
// BUILTIN_SLASH_COMMANDS in `../builtin.ts`.

import type { SlashContext } from "../builtin"
import { listSessions } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"

/**
 * Render the user's session list as a markdown table system message. Pulls
 * straight from Dexie so the result reflects on-disk state, not the in-memory
 * Zustand mirror (which only carries the active session's messages).
 */
export async function handleSessions(ctx: SlashContext): Promise<void> {
  let rows: Awaited<ReturnType<typeof listSessions>>
  try {
    rows = await listSessions()
  } catch (err) {
    ctx.pushSystemMessage(
      `Could not list sessions: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }
  if (rows.length === 0) {
    ctx.pushSystemMessage("No sessions yet. Type a message to start one.")
    return
  }
  const lines: string[] = [
    "**Sessions** (most recently updated first)",
    "",
    "| Title | Kind | Updated | ID |",
    "| --- | --- | --- | --- |",
  ]
  const now = Date.now()
  for (const s of rows) {
    const ago = formatRelative(now - s.updatedAt)
    const kind = s.kind ?? "direct"
    const title = (s.title || "(untitled)").replace(/\|/g, "\\|")
    const idShort = s.id.length > 14 ? s.id.slice(0, 14) + "…" : s.id
    lines.push(`| ${title} | ${kind} | ${ago} | \`${idShort}\` |`)
  }
  lines.push("", "Use `/resume <title or id>` to switch.")
  ctx.pushSystemMessage(lines.join("\n"))
}

/**
 * Start a fresh session — same flow as `/clear`. Kept as a separate command
 * so users coming from the CLI find the name they expect.
 */
export async function handleReset(ctx: SlashContext): Promise<void> {
  await ctx.startNewSession()
}

/**
 * Switch to an existing session by exact id, then by case-insensitive title
 * match. Reports the result as a system message either way so the user has
 * feedback even when the picker collapses.
 *
 * Resume continuity is implicit — `resolveSendOptions` auto-attaches the
 * stored `sdkSessionId` on the next send, so the SDK conversation picks up
 * exactly where it left off.
 */
export async function handleResume(ctx: SlashContext): Promise<void> {
  const arg = ctx.args.trim()
  if (!arg) {
    ctx.pushSystemMessage(
      "Usage: `/resume <id or title>` — try `/sessions` to see what's available."
    )
    return
  }
  let rows: Awaited<ReturnType<typeof listSessions>>
  try {
    rows = await listSessions()
  } catch (err) {
    ctx.pushSystemMessage(
      `Could not list sessions: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }
  if (rows.length === 0) {
    ctx.pushSystemMessage("No sessions yet.")
    return
  }
  // 1. exact id
  const exactId = rows.find((s) => s.id === arg)
  if (exactId) {
    useChatStore.getState().setActiveSession(exactId.id)
    ctx.pushSystemMessage(`Resumed \`${exactId.title}\`.`)
    return
  }
  // 2. case-insensitive exact title
  const needle = arg.toLowerCase()
  const exactTitle = rows.filter((s) => (s.title ?? "").toLowerCase() === needle)
  if (exactTitle.length === 1) {
    useChatStore.getState().setActiveSession(exactTitle[0].id)
    ctx.pushSystemMessage(`Resumed \`${exactTitle[0].title}\`.`)
    return
  }
  // 3. substring match
  const partial = rows.filter((s) => (s.title ?? "").toLowerCase().includes(needle))
  if (partial.length === 1) {
    useChatStore.getState().setActiveSession(partial[0].id)
    ctx.pushSystemMessage(`Resumed \`${partial[0].title}\`.`)
    return
  }
  if (partial.length === 0 && exactTitle.length === 0) {
    ctx.pushSystemMessage(`No session matched \`${arg}\`. Try \`/sessions\`.`)
    return
  }
  // Ambiguous — surface candidates.
  const candidates = (exactTitle.length > 1 ? exactTitle : partial)
    .slice(0, 8)
    .map((s) => `- \`${s.title}\` (\`${s.id}\`)`)
    .join("\n")
  ctx.pushSystemMessage(`\`${arg}\` matches multiple sessions; resolve by id:\n${candidates}`)
}

function formatRelative(deltaMs: number): string {
  if (deltaMs < 60_000) return "just now"
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`
  return `${Math.floor(deltaMs / 86_400_000)}d ago`
}
