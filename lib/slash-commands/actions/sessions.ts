// Action handlers for session-management slash commands.
// Each function matches the SlashCommand `handler` signature and is wired into
// BUILTIN_SLASH_COMMANDS in `../builtin.ts`.

import type { SlashContext } from "../builtin"
import type { SlashCommandResultBlock } from "../system-blocks"
import { listSessions } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { getRuntimeTranslator, type RuntimeTranslator } from "@/lib/i18n/runtime-translator"

/**
 * Everything these commands print is read by the user, so it goes through the
 * runtime translator in the locale the UI shows. It used to be English
 * literals, which a zh-CN transcript printed verbatim.
 */
const translator = () => getRuntimeTranslator("slashCommands.sessions")

/**
 * Build the inline result chip for a successful `/resume`, so the transcript
 * shows a compact "/resume <arg> — Resumed X" marker instead of a bare line.
 */
function resumedChip(
  t: RuntimeTranslator,
  arg: string,
  title: string | undefined
): SlashCommandResultBlock {
  return {
    kind: "slash-result",
    commandId: "resume",
    args: arg,
    summary: t("resumed", { title: title || t("resumedFallbackTitle") }),
  }
}

/**
 * Render the user's session list as a markdown table system message. Pulls
 * straight from Dexie so the result reflects on-disk state, not the in-memory
 * Zustand mirror (which only carries the active session's messages).
 */
export async function handleSessions(ctx: SlashContext): Promise<void> {
  const t = await translator()
  let rows: Awaited<ReturnType<typeof listSessions>>
  try {
    rows = filterExposedSessions(await listSessions(), "main-list")
  } catch (err) {
    ctx.pushSystemMessage(
      t("listFailed", { reason: err instanceof Error ? err.message : String(err) })
    )
    return
  }
  if (rows.length === 0) {
    ctx.pushSystemMessage(t("empty"))
    return
  }
  const lines: string[] = [
    t("heading"),
    "",
    `| ${t("columnTitle")} | ${t("columnKind")} | ${t("columnUpdated")} | ${t("columnId")} |`,
    "| --- | --- | --- | --- |",
  ]
  const now = Date.now()
  for (const s of rows) {
    const ago = formatRelative(t, now - s.updatedAt)
    // The kind is a protocol value (`direct`, `agent`, …), shown as-is.
    const kind = s.kind ?? "direct"
    const title = (s.title || t("untitled")).replace(/\|/g, "\\|")
    const idShort = s.id.length > 14 ? s.id.slice(0, 14) + "…" : s.id
    lines.push(`| ${title} | ${kind} | ${ago} | \`${idShort}\` |`)
  }
  lines.push("", t("footer"))
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
  const t = await translator()
  const arg = ctx.args.trim()
  if (!arg) {
    ctx.pushSystemMessage(t("resumeUsage"))
    return
  }
  let rows: Awaited<ReturnType<typeof listSessions>>
  try {
    rows = filterExposedSessions(await listSessions(), "main-list")
  } catch (err) {
    ctx.pushSystemMessage(
      t("listFailed", { reason: err instanceof Error ? err.message : String(err) })
    )
    return
  }
  if (rows.length === 0) {
    ctx.pushSystemMessage(t("resumeNoSessions"))
    return
  }
  // 1. exact id
  const exactId = rows.find((s) => s.id === arg)
  if (exactId) {
    useChatStore.getState().setActiveSession(exactId.id)
    ctx.pushSystemMessage(resumedChip(t, arg, exactId.title))
    return
  }
  // 2. case-insensitive exact title
  const needle = arg.toLowerCase()
  const exactTitle = rows.filter((s) => (s.title ?? "").toLowerCase() === needle)
  if (exactTitle.length === 1) {
    useChatStore.getState().setActiveSession(exactTitle[0].id)
    ctx.pushSystemMessage(resumedChip(t, arg, exactTitle[0].title))
    return
  }
  // 3. substring match
  const partial = rows.filter((s) => (s.title ?? "").toLowerCase().includes(needle))
  if (partial.length === 1) {
    useChatStore.getState().setActiveSession(partial[0].id)
    ctx.pushSystemMessage(resumedChip(t, arg, partial[0].title))
    return
  }
  if (partial.length === 0 && exactTitle.length === 0) {
    ctx.pushSystemMessage(t("resumeNoMatch", { query: arg }))
    return
  }
  // Ambiguous — surface candidates.
  const candidates = (exactTitle.length > 1 ? exactTitle : partial)
    .slice(0, 8)
    .map((s) => `- \`${s.title}\` (\`${s.id}\`)`)
    .join("\n")
  ctx.pushSystemMessage(`${t("resumeAmbiguous", { query: arg })}\n${candidates}`)
}

function formatRelative(t: RuntimeTranslator, deltaMs: number): string {
  if (deltaMs < 60_000) return t("justNow")
  if (deltaMs < 3_600_000) return t("minutesAgo", { count: Math.floor(deltaMs / 60_000) })
  if (deltaMs < 86_400_000) return t("hoursAgo", { count: Math.floor(deltaMs / 3_600_000) })
  return t("daysAgo", { count: Math.floor(deltaMs / 86_400_000) })
}
