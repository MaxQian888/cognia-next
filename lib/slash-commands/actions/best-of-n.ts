import type { SlashContext } from "../builtin"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { splitAgentsFlag } from "@/lib/best-of-n/agents"

export type BestOfNCommand =
  | { kind: "start"; n: 2 | 3 | 4; prompt: string; agents?: string[] }
  | { kind: "status" | "cancel" }
  | { kind: "pick"; candidate: string }
  | { kind: "invalid" }

export function parseBestOfNCommand(args: string): BestOfNCommand {
  const text = args.trim()
  if (!text) return { kind: "invalid" }
  const [head, ...tail] = text.split(/\s+/)
  const rest = text.slice(head.length).trim()
  if (head === "status" || head === "cancel") return rest ? { kind: "invalid" } : { kind: head }
  if (head === "pick")
    return tail.length === 1 ? { kind: "pick", candidate: rest } : { kind: "invalid" }
  // `[n] [--agents a,b,...] <prompt>`: one agent per candidate, in order.
  const counted = /^\d+$/.test(head)
  if (counted && !["2", "3", "4"].includes(head)) return { kind: "invalid" }
  const { agents, rest: prompt } = splitAgentsFlag(counted ? rest : text)
  if (!prompt || (agents && agents.length === 0)) return { kind: "invalid" }
  const n = counted ? Number(head) : (agents?.length ?? 2)
  if (![2, 3, 4].includes(n) || (agents && agents.length !== n)) return { kind: "invalid" }
  return { kind: "start", n: n as 2 | 3 | 4, prompt, ...(agents ? { agents } : {}) }
}

export async function handleBestOfN(ctx: SlashContext): Promise<void> {
  const t = await getRuntimeTranslator("bestOfNEntry")
  if (!ctx.activeSessionId) {
    ctx.pushSystemMessage(t("needsSession"))
    return
  }
  const command = parseBestOfNCommand(ctx.args)
  if (command.kind === "invalid") {
    ctx.pushSystemMessage(t("usage"))
    return
  }
  if (command.kind === "start") {
    if (["streaming", "awaiting_approval"].includes(ctx.chatStatus)) {
      ctx.pushSystemMessage(t("busy"))
      return
    }
    if (ctx.stagedFiles?.length) {
      ctx.pushSystemMessage(t("textOnly"))
      return
    }
    if (!ctx.startBestOfN) {
      ctx.pushSystemMessage(t("useComposer"))
      return
    }
    await ctx.startBestOfN(command.prompt, command.n, command.agents)
    return
  }
  const { bestOfNDeviceRole, listBestOfNRuns, refreshBestOfNRun } =
    await import("@/lib/best-of-n/projection")
  const runs = await listBestOfNRuns(ctx.activeSessionId)
  const latest = [...runs].sort((a, b) => b.group.createdAt - a.group.createdAt)[0]
  if (!latest) {
    ctx.pushSystemMessage(t("noRun"))
    return
  }
  // A paired observer may watch and ask the Host to stop; never pick.
  const canManage = bestOfNDeviceRole() === "host"
  if (command.kind === "pick" && !canManage) {
    ctx.pushSystemMessage(t("unavailable"))
    return
  }
  const run = canManage ? await refreshBestOfNRun(latest.id) : latest
  const group = run.group
  if (command.kind === "cancel") {
    if (canManage) {
      const { cancelBestOfN } = await import("@/lib/best-of-n/service")
      await cancelBestOfN(group.groupId)
      await refreshBestOfNRun(group.groupId)
      ctx.pushSystemMessage(t("cancelled"))
    } else {
      const { requestBestOfNCancel } = await import("@/lib/best-of-n/paired")
      await requestBestOfNCancel(group.groupId)
      ctx.pushSystemMessage(t("stopRequested"))
    }
  } else if (command.kind === "pick") {
    const candidate = group.candidates.find(
      (item) =>
        item.candidateId === command.candidate || String(item.index + 1) === command.candidate
    )
    if (!candidate) {
      ctx.pushSystemMessage(t("candidateMissing"))
      return
    }
    const { pickBestOfNCandidate } = await import("@/lib/best-of-n/publication")
    await pickBestOfNCandidate(group.groupId, candidate.candidateId)
    ctx.pushSystemMessage(t("picked"))
  } else {
    ctx.pushSystemMessage(
      t("status", {
        phase: t(`phase.${group.phase}`),
        count: group.n,
        base: group.baseSha,
        target: group.targetRef,
      }) +
        "\n" +
        group.candidates
          .map((candidate) =>
            t("candidate", {
              index: candidate.index + 1,
              status: t(`candidateStatus.${candidate.status}`),
            })
          )
          .join("\n")
    )
  }
}
