"use client"

/**
 * Editor for a subagent's tool allowlist — the single most consequential knob
 * a subagent has, and one the template editor previously did not expose at
 * all. `projectSubagentTemplate` has always read `config.tools` into the SDK
 * `AgentDefinition`; there was simply no way to write it.
 *
 * The control is a tri-state segment rather than a plain multi-select because
 * the underlying field has three genuinely different meanings that a
 * multi-select renders identically:
 *
 *   undefined  inherit the parent's tools   (the SDK's documented default)
 *   ["a","b"]  exactly these tools
 *   []         no tools at all
 *
 * `if (tpl.config.tools)` in the projector treats `[]` as truthy, so an empty
 * array really does ship `tools: []` and strand the subagent with nothing.
 * Making the mode an explicit choice means a user who deselects their last
 * tool lands on "custom, empty" and can see it, instead of silently flipping
 * the semantics of the field.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import type { ToolSource } from "@/lib/tools/tool-catalog"

import { ToolCatalogDialog } from "./tool-catalog-dialog"

export type ToolScopeMode = "inherit" | "custom" | "none"

const MODES: readonly ToolScopeMode[] = ["inherit", "custom", "none"]

/** Which of the three states a stored value represents. */
export function toolScopeMode(value: readonly string[] | undefined): ToolScopeMode {
  if (value === undefined) return "inherit"
  return value.length === 0 ? "none" : "custom"
}

/**
 * The value a mode should store. `remembered` lets a user flip to "inherit"
 * and back without retyping the list they had built.
 */
export function toolScopeValue(
  mode: ToolScopeMode,
  remembered: readonly string[]
): string[] | undefined {
  if (mode === "inherit") return undefined
  if (mode === "none") return []
  return [...remembered]
}

export interface ToolScopeFieldProps {
  label: string
  description?: string
  value: string[] | undefined
  onChange: (value: string[] | undefined) => void
  /** Restrict the catalog dialog — `mcpServerIds` only wants MCP servers. */
  sources?: readonly ToolSource[]
  /** Disambiguates the test ids when a panel renders two of these. */
  testId?: string
}

export function ToolScopeField({
  label,
  description,
  value,
  onChange,
  sources,
  testId = "tool-scope",
}: ToolScopeFieldProps) {
  const t = useTranslations("settings.subagents.toolScope")
  const { reduce, durationScale } = useFlowMotion()
  const [catalogOpen, setCatalogOpen] = useState(false)
  // Survives a round-trip through "inherit" / "none" so the list is not lost.
  const [remembered, setRemembered] = useState<string[]>(value ?? [])

  const mode = toolScopeMode(value)
  const selected = value ?? []
  // A live list is its own memory; `remembered` only matters once the field
  // has been emptied by switching to inherit/none.
  const effectiveRemembered = selected.length > 0 ? selected : remembered

  const selectMode = (next: ToolScopeMode) => {
    onChange(toolScopeValue(next, effectiveRemembered))
  }

  const setSelected = (next: string[]) => {
    setRemembered(next)
    onChange(next)
  }

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="space-y-0.5">
        <Label className="text-xs">{label}</Label>
        {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      </div>

      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex rounded-md border p-0.5"
        data-testid={`${testId}-mode`}
      >
        {MODES.map((m) => (
          <Button
            key={m}
            type="button"
            role="radio"
            variant="ghost"
            size="sm"
            aria-checked={mode === m}
            onClick={() => selectMode(m)}
            data-testid={`${testId}-mode-${m}`}
            className={cn(
              "rounded px-2.5 py-1 text-[11px] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mode === m
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            )}
          >
            {t(`modes.${m}`)}
          </Button>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground" data-testid={`${testId}-mode-hint`}>
        {t(`modeHints.${mode}`)}
      </p>

      <AnimatePresence initial={false}>
        {mode === "custom" ? (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={
              reduce
                ? { duration: 0 }
                : { duration: MOBILE_DURATION.fast * durationScale, ease: MOBILE_EASE }
            }
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-1 pt-1">
              {selected.map((tool) => (
                <span
                  key={tool}
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px]"
                  data-testid={`${testId}-chip-${tool}`}
                >
                  <span className="max-w-[16rem] truncate">{tool}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setSelected(selected.filter((x) => x !== tool))}
                    aria-label={t("removeTool", { tool })}
                    className="size-4 text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setCatalogOpen(true)}
                data-testid={`${testId}-open-catalog`}
              >
                <PlusIcon className="mr-1 size-3" />
                {t("pickFromCatalog")}
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <ToolCatalogDialog
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        selected={selected}
        onConfirm={setSelected}
        sources={sources}
      />
    </div>
  )
}
