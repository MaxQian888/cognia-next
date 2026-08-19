"use client"

// Bottom toolbar of the composer — a status line, not a control panel.
//
// It used to inline every tier at once: model, effort, permission, sandbox,
// enhance, web search, skills, agent mode, two plugin slots, quick actions,
// "⋯", and context usage — a dozen controls under the input box. Of those,
// exactly two answer the question a user asks before every turn ("what will
// this run as"), so those two stay: the model chip (carrying its effort
// qualifier) and the permission chip, with the context ring beside them.
//
// Turn capabilities (enhance, web search, skills) live under the composer's `+`
// on both desktop and mobile.
//
// The "⋯" overflow is a PACKING device, not a tier: it exists only where the
// row genuinely cannot hold the roster (mobile / the narrow workflow sidebar).
// On a wide composer the remaining session-shape controls — Agent mode, the
// sandbox indicator, plugin slots — render inline, because collapsing them
// there hid state the user is expected to read at a glance (which mode, is the
// sandbox on) behind a button with no affordance for what it contains.
//
// Two rules keep that inline roster from turning back into the wall of text it
// was (nine labelled chips, the last of which painted over its neighbour on an
// 832px reading column):
//
//  1. **Labels are earned by not being default.** A control sitting on its
//     shipped value is a glyph with a tooltip; the moment it holds something
//     the user chose, it spells that choice out. The runtime chip and the
//     system-prompt preset chip both work this way, so a stock session reads
//     `model · thinking · permission ┆ Standard ▾ 🤖 ✨` instead of repeating
//     "Claude SDK" and "No preset" under every turn.
//  2. **Everything shrinks.** Every chip is `min-w-0 shrink` (the shadcn button
//     base is `shrink-0`), so a long provider model id ellipsizes inside its
//     own box. Without it the group shrank, its `shrink-0` children did not,
//     and they overflowed the group's box to paint on top of the next control.
//
// Grouping is carried by ONE hairline: per-turn answers (model, thinking,
// permission) on the left of it, session shape (mode, runtime, preset) on the
// right, ambient status pinned to the far end.

import { useRef, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { MoreHorizontalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useElementWidth } from "@/hooks/use-element-width"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"
import { ContextUsageIndicator } from "@/components/chat/context-usage-indicator"
import { useSdkContextUsage } from "@/hooks/chat/use-sdk-context-usage"
import { useChatStore, type ChatStatus } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@cognia/agent-config-types"
import { PermissionModeIndicator } from "../permission-mode-indicator"
import { ModelPicker } from "./model-picker"
import { EffortChip } from "./effort-chip"
import { SandboxShield } from "./sandbox-shield"
import { AgentRuntimeSelector } from "@/components/agent/mode/runtime-selector"
import { CompositionChip } from "@/components/agent/composition/composition-chip"
import { useAgentRuntimeStore } from "@/stores/agent"
import { PluginExtensionSlotWithOverflow } from "@/components/plugins/plugin-extension-slot-with-overflow"
import { PluginQuickActionsMenu } from "./plugin-quick-actions-menu"
import { WorkflowBottomToolbar } from "./workflow-bottom-toolbar"
import { ComposerPresetChip } from "./preset-chip"
import { ComposerCredentialBadge } from "./credential-badge"
import { SessionCostBadgeLive } from "@/components/chat/session-cost-badge-live"

interface BottomToolbarProps {
  session: ChatSession | null
  status?: ChatStatus
  variant?: "default" | "embedded"
  leading?: ReactNode
  /** Where the "No API key" badge sends the user — provider settings. */
  onOpenProviderSettings?: () => void
}

export function BottomToolbar({
  session,
  status,
  variant = "default",
  leading,
  onOpenProviderSettings,
}: BottomToolbarProps) {
  // The workflow-editor session is the same discriminator that
  // `resolveSendOptions` keys on to inject workflow subagents + the graph
  // snapshot. The composer surface deserves the same scoping: the generic
  // runtime / mode / external-agent / web-search / generic-skills / generic
  // plugin-slot controls have no useful meaning inside a workflow chat.
  if (session?.kind === "workflow-editor") {
    if (variant === "embedded") {
      return (
        <div className="min-w-0 flex-1" data-testid="composer-toolbar-embedded">
          <WorkflowBottomToolbar session={session} />
        </div>
      )
    }
    return <WorkflowBottomToolbar session={session} />
  }
  return (
    <GenericBottomToolbar
      session={session}
      status={status}
      variant={variant}
      leading={leading}
      onOpenProviderSettings={onOpenProviderSettings}
    />
  )
}

function GenericBottomToolbar({
  session,
  status: paneStatus,
  variant = "default",
  leading,
  onOpenProviderSettings,
}: BottomToolbarProps) {
  const t = useTranslations("chat.composer.toolbar")
  // The cost badge's token label lived with the header these moved out of.
  const tHeader = useTranslations("chat.header")
  const focusedStatus = useChatStore((s) => s.status)
  const status = paneStatus ?? focusedStatus
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarWidth = useElementWidth(rootRef)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const runtime = useAgentRuntimeStore((s) => s.runtime)

  // Disable toolbar controls while a turn is in flight so mid-stream
  // configuration changes (model, runtime, mode, etc.) can't race the send.
  const isStreaming = status === "streaming" || status === "awaiting_approval"

  // Mirrors `lib/claude/build-options.ts` model resolution: per-session
  // override > app default. (Character / member overrides aren't loaded
  // here — the user-facing display is the most-likely-active value.)
  const modelId = session?.model ?? defaultModel ?? "claude-sonnet-4-5"
  const providerId = session?.providerOverride ?? defaultProvider ?? "anthropic"

  // SDK-authoritative context usage for the live session (Anthropic + desktop
  // only; falls back to the message-derived estimate inside the indicator).
  const { snapshot: sdkUsage } = useSdkContextUsage(session?.id ?? null, providerId)

  // The measured width only decides how the same set of controls is packed,
  // not which of them exist — every branch renders the identical roster, so no
  // control mounts in two places. (That invariant is why the overflow is a
  // Popover: re-mounting a trigger-owning control inside a `DropdownMenuItem`
  // desyncs its open state.) `toolbarWidth === 0` (pre-measure) takes the wide
  // branch, matching the common chat pane.
  const compact = toolbarWidth > 0 && toolbarWidth < COMPACT_TOOLBAR_PX
  const tierActive = runtime !== "claude-sdk"

  // Runtime AND the external agent it dispatches to are one choice in one
  // dropdown (see `runtime-selector.tsx`) — there is no second "which agent"
  // control to place, and no way to sit on an external lane with nothing
  // selected.
  const runtimeControl = <AgentRuntimeSelector disabled={isStreaming} className={TOOLBAR_CHIP} />

  // Agent Mode composes the preset the Claude SDK runtime runs under; it is
  // meaningless for an external CLI agent, which brings its own.
  //
  // Scoped to THIS session (ADR-0117). The chip it replaced wrote the app-wide
  // default, so it could not change the conversation it sat under once the
  // settings sheet had recorded a per-session choice — and it rendered any
  // session running Minimal/Code/Creator as "General Assistant", because those
  // presets have no `AgentModeConfig` to look up.
  //
  // On the wide row the preset sits directly on the toolbar and the axes get
  // their own button; inside the "⋯" overflow there is no row to spread over,
  // so both packings collapse into the single chip.
  const modeControl =
    runtime === "claude-sdk" ? (
      <CompositionChip
        sessionId={session?.id}
        disabled={isStreaming}
        layout={compact || variant === "embedded" ? "combined" : "split"}
      />
    ) : null

  // Passive indicator, not a control — it belongs beside the context ring
  // rather than inside a menu the user has to open to learn whether this turn
  // is sandboxed.
  const sandboxIndicator = <SandboxShield session={session} />

  // Plugin-contributed composer actions. Each renders arbitrary plugin UI,
  // often with its own trigger, and the overflow Popover is the container
  // already proven safe for that. All three self-hide when no plugin
  // contributes, so the default install pays nothing for them — inline or not.
  const pluginSlots = (
    <>
      <PluginExtensionSlotWithOverflow
        point="chat.input.actions"
        limit={3}
        className="flex items-center gap-1 empty:hidden"
        overflowLabel={t("pluginExtensionOverflow")}
      />
      {/* ADR-0026 §3 §C — composer dropdown groups. Distinct from */}
      {/* chat.input.actions (flat buttons) so plugins can ship grouped */}
      {/* quick actions under a single trigger. */}
      <PluginExtensionSlotWithOverflow
        point="chat.input.menu"
        limit={3}
        className="flex items-center gap-1 empty:hidden"
        overflowLabel={t("pluginExtensionOverflow")}
      />
      {/* Declarative quick actions (manifest `quickActions[]` /
          ctx.quickActions) — renders nothing when no plugin
          contributed composer-surface actions. */}
      <PluginQuickActionsMenu disabled={isStreaming} />
    </>
  )

  // The per-turn answers: which model, how deeply it thinks, what it may do
  // without asking. These three change between one send and the next, so they
  // are the only group that is always labelled in full.
  //
  // Every control wears the same quiet chip (`TOOLBAR_CHIP`): no fill, no
  // border, hover-only affordance, and shrinkable so a long model id
  // ellipsizes instead of spilling over its neighbour.
  const runConfigGroup = (
    <div
      className="flex min-w-0 flex-nowrap items-center gap-0.5"
      data-testid="composer-execution-controls"
    >
      <ModelPicker
        session={session}
        disabled={isStreaming}
        className={cn(TOOLBAR_CHIP, "max-w-[11rem]")}
      />
      {/* Thinking level sits immediately after the model because it qualifies
          it — the pair reads as one answer to "how deeply will this run". It
          self-hides on a surface with no depth control, which is why it can
          live on the permanent row rather than behind the overflow. */}
      {/* The two short labels hold their ground: "Auto" abbreviated to "A…"
          teaches nothing, and the model id beside them is the only string on
          this side long enough to be worth ellipsizing. Below the compact
          threshold the whole row re-packs instead of shaving letters. */}
      <EffortChip
        session={session}
        disabled={isStreaming}
        className={cn(TOOLBAR_CHIP, "max-w-[7.5rem] shrink-0")}
      />
      <PermissionModeIndicator
        onCycle={(next) => setPermissionMode(next)}
        disabled={isStreaming}
        className={cn(TOOLBAR_CHIP, "shrink-0")}
      />
    </div>
  )
  // The system-prompt preset shapes the session the way the mode and runtime
  // beside it do, so it joins them on the right of the hairline (it moved down
  // from the chat header, which is title-bar chrome now). Self-hides without
  // presets; wears the glyph until one is actually active.
  const presetControl = session ? (
    <ComposerPresetChip session={session} disabled={isStreaming} className={TOOLBAR_CHIP} />
  ) : null
  // Ambient session status that used to crowd the header: what this session
  // has cost, and the one credential state that would stop the next send.
  const sessionStatus = session ? (
    <>
      <SessionCostBadgeLive
        sessionId={session.id}
        tokensLabel={(input, output) => tHeader("tokensLabel", { input, output })}
      />
      <ComposerCredentialBadge onOpenSettings={onOpenProviderSettings} />
    </>
  ) : null
  // Session shape — how the agent is composed, where it executes, and which
  // system prompt it carries. Set once per conversation rather than per turn,
  // so this side of the hairline is where the "label only when non-default"
  // rule does its work: on a stock session it is one labelled chip and two
  // glyphs.
  const shapeGroup = (
    <div
      // Yields width three times as fast as the per-turn group beside it: when
      // the pane narrows, "Standard" giving up letters costs less than the
      // model id and the permission mode doing the same.
      className="flex min-w-0 shrink-[3] flex-nowrap items-center gap-0.5"
      data-testid="composer-shape-controls"
    >
      {modeControl}
      {runtimeControl}
      {presetControl}
    </div>
  )

  const contextIndicator = (
    <ContextUsageIndicator
      modelId={modelId}
      providerId={providerId}
      sdkUsage={sdkUsage}
      triggerClassName={cn(TOOLBAR_CHIP, "shrink-0 px-1.5")}
    />
  )

  // Narrow packing only. A Popover, not a DropdownMenu: the agent-mode selector
  // and the plugin slots own their own overlays, and re-mounting those inside a
  // `DropdownMenuItem` desyncs their open state.
  const overflow = (
    <ToolbarMoreMenu label={t("moreControls")} active={tierActive} disabled={isStreaming}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {presetControl}
          {modeControl}
          {sandboxIndicator}
        </div>
        <div className="flex flex-wrap items-center gap-2">{pluginSlots}</div>
      </div>
    </ToolbarMoreMenu>
  )

  // Both narrow layouts pack the tail into "⋯"; the wide one lays it out.
  if (variant === "embedded") {
    return (
      <div
        ref={rootRef}
        className="flex min-w-0 flex-1 items-center justify-end gap-1 text-[11px] text-muted-foreground"
        data-testid="composer-toolbar-embedded"
      >
        {runConfigGroup}
        <ToolbarDivider />
        {runtimeControl}
        {sessionStatus}
        {contextIndicator}
        {overflow}
      </div>
    )
  }

  // Compact (mobile / narrow workflow sidebar): two rows at most — Tier 1 on
  // the first, context usage + overflow sharing the second.
  if (compact) {
    return (
      <div
        ref={rootRef}
        className="mt-2 flex flex-col gap-1 px-1 text-[11px] text-muted-foreground"
      >
        <div className="flex min-w-0 items-center gap-1">
          {leading}
          {runConfigGroup}
        </div>
        <div className="flex items-center justify-end gap-x-1">
          {runtimeControl}
          {sessionStatus}
          {contextIndicator}
          {overflow}
        </div>
      </div>
    )
  }

  // Wide (web / desktop): one row, three zones — per-turn config, one hairline,
  // session shape, then the ambient status cluster pinned right by `ml-auto`.
  // Nothing is collapsed here — the row has the space once the default-valued
  // chips are glyphs, and a "⋯" that hides the active Agent mode costs a click
  // to answer a question the user asks on every turn.
  return (
    <div
      ref={rootRef}
      className="mt-2 flex min-w-0 flex-nowrap items-center gap-x-1 px-1 text-[11px] text-muted-foreground"
      data-testid="composer-footer"
    >
      {leading}
      {runConfigGroup}
      <ToolbarDivider />
      {shapeGroup}
      <div className="flex shrink-0 items-center gap-1 empty:hidden">{pluginSlots}</div>
      {/* Read-only ambient state, held apart from the controls by the auto
          margin rather than by another rule — the gap IS the grouping, and one
          hairline per row is the whole divider budget. */}
      <div
        className="ml-auto flex shrink-0 items-center gap-0.5 pl-3"
        data-testid="composer-status-cluster"
      >
        {sessionStatus}
        {contextIndicator}
        {sandboxIndicator}
      </div>
    </div>
  )
}

/**
 * Below this measured width, split the status line into two compact rows.
 *
 * 384 → 520. The one-row packing needs about 520px before the only chips with
 * long labels (the model id, the composition preset) are shaved past reading —
 * and past that point every other chip starts giving up letters too, which is
 * how a 420px pane ended up rendering "A…" and "Def…". Two honest rows beat one
 * row of stubs; the compact branch already exists and holds the full roster.
 */
const COMPACT_TOOLBAR_PX = 520

/**
 * The one chip style every toolbar control wears. Overrides each control's
 * own default (outline / muted fill / rounded-lg) so the row reads as a single
 * quiet strip: same height, same radius, hover-only affordance, no fills or
 * borders competing with the composer frame above it.
 *
 * `min-w-0 shrink` is load-bearing, not tidiness: the shadcn button base is
 * `shrink-0`, so a chip inside a `min-w-0` group kept its full intrinsic width
 * while the group compressed — and the surplus rendered OUTSIDE the group, on
 * top of whatever followed it (the "No preset" chip printing through the
 * runtime chip). Shrinkable chips ellipsize their own label instead.
 */
export const TOOLBAR_CHIP =
  "h-7 min-w-0 shrink rounded-md border-transparent bg-transparent px-2 text-[11px] font-normal text-muted-foreground shadow-none hover:border-transparent hover:bg-muted/60 hover:text-foreground dark:border-transparent dark:bg-transparent dark:hover:bg-muted/60"

/** Thin vertical rule between control groups on the wide row. */
function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-3.5 w-px shrink-0 bg-border/50" />
}

/**
 * Compact "⋯ More" popover holding the toolbar controls that don't fit on a
 * narrow composer (e.g. inside the workflow chat sidebar). A `Popover` — not a
 * `DropdownMenu` — so the nested popover-trigger controls inside it keep their
 * own open-state (Radix's DismissableLayer stack handles the nesting).
 */
function ToolbarMoreMenu({
  label,
  active,
  disabled,
  children,
}: {
  label: string
  active: boolean
  disabled: boolean
  children: ReactNode
}) {
  const isMobile = usePlatform() === "mobile"
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          data-testid="composer-toolbar-more"
          className={cn("relative size-7", isMobile && "touch-target")}
        >
          <MoreHorizontalIcon className="size-3.5" />
          {active && (
            <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-auto max-w-[80vw] p-2">
        {children}
      </PopoverContent>
    </Popover>
  )
}
