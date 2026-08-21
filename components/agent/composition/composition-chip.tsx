"use client"

/**
 * The composer's mode control (ADR-0117).
 *
 * Replaces `AgentModeSelector` on the composer row. Two reasons, both defects
 * rather than preferences:
 *
 * 1. **It was session-blind.** It wrote `setModeId`, which is the *app default*
 *    composition. `compositionForSession` prefers the per-session entry, so once
 *    the settings sheet had written one, this chip silently stopped affecting
 *    the conversation it sits under while still rendering as the active mode.
 *
 * 2. **It cannot name half the presets.** `AgentModeSelector` resolves through
 *    `BUILT_IN_AGENT_MODES`, which has no record for `standard`, `minimal`,
 *    `code` or `creator`, and falls back to `builtInModes[0]`. A session running
 *    Minimal rendered as "General Assistant". Making it session-aware would have
 *    moved that lie rather than fixed it.
 *
 * So the chip reads and writes the same composition the settings sheet does, and
 * opens the same `CompositionPicker` rather than a second list of modes. Team
 * navigation and custom-mode CRUD, which the old dropdown also carried, already
 * have first-class homes (the guild rail and Settings → Agent modes).
 *
 * Two layouts, chosen by the toolbar from its measured width:
 *
 * - `split` (wide): the preset is a dropdown right on the row — the question
 *   asked on every turn should not cost a popover — and a separate "Advanced"
 *   button opens the axes + resolved summary. Same store writes, same picker.
 * - `combined` (narrow / inside the "⋯" overflow): one chip, one popover with
 *   the full picker, preset included.
 *
 * The advanced panel is a `Popover`, not a `DropdownMenu`: the picker mounts
 * Radix `Select`s, and a menu that closes on outside-press fights nested
 * overlays — the same reason `bottom-toolbar.tsx` uses a Popover for its
 * overflow. The preset list has no nested overlay, so it can be a plain menu.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, SlidersHorizontal } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { CompositionPicker } from "./composition-picker"
import { usePresetCatalog } from "@/hooks/agent/use-preset-catalog"
import { useCodeSandboxPresentations } from "@/hooks/agent/use-code-sandbox-presentations"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { resolveComposition } from "@/lib/agent/composition/resolve-composition"
import { presetDisplayName } from "@/lib/agent/composition/preset-label"
import { STANDARD_PRESET, visiblePresets } from "@/lib/agent/composition/preset-catalog"
import { CHAT_SUPPORTED_ORCHESTRATIONS } from "@/lib/agent/composition/chat-orchestrations"
import { useChatExecutor } from "./use-chat-executor"
import { ExecutorChoiceList, ExecutorMenuSection } from "./executor-choice"

const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`

/** Axes a user can pin independently of the preset. */
const AXES = ["authority", "toolPresentation", "orchestration"] as const

export type CompositionChipLayout = "combined" | "split"

export interface CompositionChipProps {
  /** Absent before the first turn, when there is no session to scope to. */
  sessionId?: string
  disabled?: boolean
  /** `split` puts the preset on the row and the axes behind a second button. */
  layout?: CompositionChipLayout
  className?: string
}

export function CompositionChip({
  sessionId,
  disabled = false,
  layout = "combined",
  className,
}: CompositionChipProps) {
  const t = useTranslations("agentComposition")
  const tModes = useTranslations("agentMode.modes")
  const [open, setOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const presets = usePresetCatalog()
  const supportedToolPresentations = useCodeSandboxPresentations()
  const developerMode = usePluginStore((s) => s.pluginSettings.developerModeEnabled)

  // Subscribed, not read via getState(): the settings sheet writes the same
  // entry, and the chip has to follow it or the two disagree again.
  const selection = useAgentRuntimeStore((s) =>
    sessionId && Object.hasOwn(s.sessionCompositions, sessionId)
      ? s.sessionCompositions[sessionId]
      : s.defaultComposition
  )
  const setSessionComposition = useAgentRuntimeStore((s) => s.setSessionComposition)
  const setDefaultComposition = useAgentRuntimeStore((s) => s.setDefaultComposition)

  const executor = useChatExecutor(sessionId)

  const resolved = useMemo(
    () =>
      resolveComposition({
        selection,
        presets,
        supportedToolPresentations,
        // Told, at last. Without this the resolver assumed every orchestration
        // was runnable here, so picking one that is not did nothing and said
        // nothing.
        supportedOrchestrations: CHAT_SUPPORTED_ORCHESTRATIONS,
        promptDigest: PLACEHOLDER_DIGEST,
        toolDigest: PLACEHOLDER_DIGEST,
      }),
    [selection, presets, supportedToolPresentations]
  )

  const offered = useMemo(
    () => visiblePresets(presets, { developerMode, includeExperimental: false }),
    [presets, developerMode]
  )

  // `resolveComposition` guarantees `presetId` is either a preset in this
  // catalog or Standard, and `usePresetCatalog()` always contains Standard —
  // so the lookup cannot miss, and a "not found" branch here would be dead code
  // claiming otherwise.
  const activePreset = presets.find((preset) => preset.id === resolved.presetId) ?? STANDARD_PRESET
  const presetLabel = presetDisplayName(activePreset, tModes)
  // A dangling binding gets its own label rather than the preset's: falling
  // back silently would read as "running normally".
  const squadGone = executor.squadId !== null && executor.squadName === null
  const label = executor.squadName ?? (squadGone ? t("executor.squadMissing") : presetLabel)

  const narrowed = resolved.warnings.length > 0 || squadGone
  const overrideCount = AXES.filter((axis) => selection[axis] !== undefined).length

  function commit(next: typeof selection): void {
    if (sessionId) setSessionComposition(sessionId, next)
    else setDefaultComposition(next)
  }

  // Same quiet chip as the rest of the composer row (see `TOOLBAR_CHIP` in
  // `bottom-toolbar.tsx`): no fill, no border, hover-only affordance, and
  // shrinkable — the shadcn button base is `shrink-0`, which is how a chip on
  // that row ends up painting over its neighbour instead of ellipsizing.
  const chipClass = cn(
    "h-7 min-w-0 shrink gap-1 rounded-md px-2 text-[11px] font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground",
    className
  )

  if (layout === "split") {
    return (
      <div className="flex min-w-0 items-center gap-0.5" data-testid="composition-controls">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid="composition-chip"
              data-narrowed={narrowed || undefined}
              aria-label={t("chip.ariaLabel", { preset: label })}
              title={narrowed ? t("chip.narrowed") : t("chip.ariaLabel", { preset: label })}
              className={cn(chipClass, "max-w-[11rem]")}
            >
              <span className="truncate">{label}</span>
              {narrowed ? <NarrowedDot /> : null}
              <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-56"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <ExecutorMenuSection executor={executor} disabled={disabled} />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("presetLabel")}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="max-h-72 overflow-y-auto" data-testid="composition-preset-list">
              <DropdownMenuRadioGroup
                value={selection.presetId}
                onValueChange={(presetId) => commit({ ...selection, presetId })}
              >
                {offered.map((preset) => (
                  <DropdownMenuRadioItem
                    key={preset.id}
                    value={preset.id}
                    className="gap-2 text-xs"
                  >
                    <span className="truncate">{presetDisplayName(preset, tModes)}</span>
                    {preset.experimental ? (
                      <Badge variant="outline" className="ml-auto text-[10px]">
                        {t("badges.experimental")}
                      </Badge>
                    ) : null}
                    {preset.visibility === "developer-only" ? (
                      <Badge variant="outline" className="ml-auto text-[10px]">
                        {t("badges.developerOnly")}
                      </Badge>
                    ) : null}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid="composition-advanced-trigger"
              data-overrides={overrideCount || undefined}
              aria-label={t("advanced")}
              title={t("advanced")}
              className={cn(
                chipClass,
                "size-7 shrink-0 justify-center p-0",
                overrideCount > 0 && "w-auto gap-1 px-1.5 text-foreground"
              )}
            >
              <SlidersHorizontal aria-hidden className="size-3.5" />
              {overrideCount > 0 ? (
                <span
                  className="rounded-sm bg-primary/15 px-1 text-[10px] leading-4 tabular-nums"
                  data-testid="composition-advanced-count"
                >
                  {overrideCount}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-3">
            <div className="mb-3 flex items-center gap-2">
              <SlidersHorizontal aria-hidden className="size-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">{t("advanced")}</p>
              <span className="ml-auto truncate text-[11px] text-muted-foreground">{label}</span>
            </div>
            <CompositionPicker
              presets={presets}
              selection={selection}
              onChange={commit}
              developerMode={developerMode}
              presetControl={false}
              supportedToolPresentations={supportedToolPresentations}
              supportedOrchestrations={CHAT_SUPPORTED_ORCHESTRATIONS}
            />
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          data-testid="composition-chip"
          data-narrowed={narrowed || undefined}
          aria-label={t("chip.ariaLabel", { preset: label })}
          title={narrowed ? t("chip.narrowed") : t("chip.ariaLabel", { preset: label })}
          className={cn(chipClass, "max-w-[9rem]")}
        >
          <span className="truncate">{label}</span>
          {narrowed ? <NarrowedDot /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <ExecutorChoiceList executor={executor} disabled={disabled} />
        <CompositionPicker
          presets={presets}
          selection={selection}
          onChange={commit}
          developerMode={developerMode}
          advancedOpen={advancedOpen}
          onAdvancedOpenChange={setAdvancedOpen}
          supportedToolPresentations={supportedToolPresentations}
          supportedOrchestrations={CHAT_SUPPORTED_ORCHESTRATIONS}
        />
      </PopoverContent>
    </Popover>
  )
}

function NarrowedDot() {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 rounded-full bg-amber-500"
      data-testid="composition-chip-warning-dot"
    />
  )
}

export default CompositionChip
