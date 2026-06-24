"use client"

// Structured card for the plan-mode signal tools `exit_plan_mode`
// (cognia, also namespaced `mcp__cognia-tools__exit_plan_mode`) and the
// native Anthropic `ExitPlanMode`. Both pass the final plan as a single
// markdown string in `input.plan`; we render it with the shared
// MarkdownRenderer so headings / lists / code in the plan format properly.

import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import { McpCardShell } from "./common"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"

export function PlanCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.plan")
  const input = (part.input ?? {}) as { plan?: unknown }
  const plan = typeof input.plan === "string" ? input.plan.trim() : ""
  if (!plan) return null

  return (
    <McpCardShell title={t("title")} testId="mcp-plan-card">
      <div data-testid="mcp-plan-body" className="text-sm">
        <MarkdownRenderer content={plan} />
      </div>
    </McpCardShell>
  )
}
