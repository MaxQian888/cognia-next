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
// row genuinely cannot hold the roster. What folds is decided by the fold
// ladder (`resolveToolbarFoldTier` in `lib/chat/composer-skin.ts`): the
// measured width maps to a tier, and each tier surrenders the next-least-
// essential controls — first into a glyph form on the row, then into the
// disclosure. Folding never drops a control; the same element renders its
// full labelled form inside the popover.
//
// Two rules keep the inline roster from turning back into the wall of text it
// was (nine labelled chips, the last of which painted over its neighbour on
// an 832px reading column):
//
//  1. **Labels are earned by not being default.** A control sitting on its
//     shipped value is a glyph with a tooltip; the moment it holds something
//     the user chose, it spells that choice out. The runtime chip and the
//     system-prompt preset chip both work this way, so a stock session reads
//     `model · thinking · permission ┆ Standard ▾ 🤖 ✨` instead of repeating
//     "Claude SDK" and "No preset" under every turn.
//  2. **Every label can give up room.** A text-bearing chip is `min-w-0 shrink`
//     (the shadcn button base is `shrink-0`), so a squeezed row ellipsizes
//     labels inside their own boxes instead of letting them paint over the
//     next control — which is what `shrink-0` chips did the moment their group
//     hit its floor. Anything that cannot ellipsize (glyph chips, the status
//     cluster) is bounded to a fixed footprint instead.
//
// Every zone boundary carries a hairline: per-turn answers (model, thinking,
// permission) | session shape (mode, runtime, preset) | plugin actions |
// ambient status pinned to the far end. A zone that renders nothing takes its
// rule with it (the rule is a `::before`, which `:empty` does not count), so a
// default install never shows a rule with nothing on one side of it.

import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import { useRef, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { MoreHorizontalIcon, UsersIcon } from "lucide-react"
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
import { FusionModeChip } from "./fusion-mode-chip"
import { SandboxShield } from "./sandbox-shield"
import { AgentRuntimeSelector } from "@/components/agent/mode/runtime-selector"
import { CompositionChip } from "@/components/agent/composition/composition-chip"
import { useChatExecutor } from "@/components/agent/composition/use-chat-executor"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { PluginExtensionSlotWithOverflow } from "@/components/plugins/plugin-extension-slot-with-overflow"
import { PluginQuickActionsMenu } from "./plugin-quick-actions-menu"
import { WorkflowBottomToolbar } from "./workflow-bottom-toolbar"
import {
  resolveToolbarFoldTier,
  resolveToolbarLayout,
  type ComposerToolbarLayout,
} from "@/lib/chat/composer-skin"
import { ComposerPresetChip } from "./preset-chip"
import { ComposerCredentialBadge } from "./credential-badge"
import { SessionCostBadgeLive } from "@/components/chat/session-cost-badge-live"
import { useComposerSessionId } from "./composer-session-context"

interface BottomToolbarProps {
  session: ChatSession | null
  status?: ChatStatus
  /**
   * How this row is arranged — chosen by the active composer skin, then
   * narrowed by the measured pane (see `resolveToolbarLayout`). Every branch
   * renders the SAME roster; they differ only in what sits inline and what is
   * packed into the "⋯" disclosure. `"default"` is the legacy alias for
   * `"detached"` and is what a caller that has no opinion still passes.
   */
  variant?: "default" | ComposerToolbarLayout
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
    // A workflow chat has no runtime / mode / skills roster to arrange, so
    // every in-box layout collapses to the one embedded form.
    if (variant !== "default" && variant !== "detached") {
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
  const composerSessionId = useComposerSessionId()
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarWidth = useElementWidth(rootRef)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const runtimeRef = useRuntimeRefForSession(session?.id)
  // Live, not derived from the `session` prop: binding a Squad has to change
  // this row in the same tick the chip changes, and the prop's freshness is
  // the caller's business.
  const executor = useChatExecutor(session?.id)
  const tComposition = useTranslations("agentComposition.executor")

  // Disable toolbar controls while a turn is in flight so mid-stream
  // configuration changes (model, runtime, mode, etc.) can't race the send.
  const isStreaming = status === "streaming" || status === "awaiting_approval"

  // Mirrors `lib/claude/build-options.ts` model resolution: per-session
  // override > app default. (Character / member overrides aren't loaded
  // here — the user-facing display is the most-likely-active value.)
  const modelId = session?.model ?? defaultModel ?? ANTHROPIC_DEFAULT_MODEL
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
  // Skin proposes, width disposes. The skin picked an arrangement for a
  // comfortable pane; a genuinely narrow one cannot hold `expanded`'s labelled
  // roster whatever the user chose.
  const proposedLayout: ComposerToolbarLayout = variant === "default" ? "detached" : variant
  const layout = resolveToolbarLayout(proposedLayout, toolbarWidth)
  // The fold ladder — WHICH controls the width can still hold, and in what
  // form. `resolveToolbarFoldTier`'s doc lists the rungs; these booleans are
  // only their spellings for this row. What folds always lands in the same
  // "⋯" disclosure, in its full labelled form.
  const tier = resolveToolbarFoldTier(toolbarWidth)
  const onBuiltinRuntime = runtimeRef.kind === "builtin"
  const tierActive = !onBuiltinRuntime

  /** The per-turn chips run icon-only — the words cost more than they teach. */
  const glyphChips = tier >= 2
  /** Mode + runtime keep their own zone left of the status cluster. */
  const shapeInline = tier <= 1
  /** Preset, sandbox and the plugin slots fold behind "⋯". */
  const sessionFolded = tier >= 1
  /** Agent mode joins the "⋯" group. */
  const modeFolded = tier >= 2
  /** The Router + Fusion chip joins the "⋯" group — but never on a Squad-bound
      conversation, whose members each run their own models: the fold must not
      offer there a control the send path would ignore. */
  const fusionFolded = tier >= 3 && !executor.squadId
  /** The session-cost badge joins the "⋯" group (full form inside). */
  const costFolded = tier >= 3
  /** Session cost stays inline but drops to the `$x.xx` short form. */
  const costShort = tier === 1 || tier === 2
  /** The context indicator drops its percentage and keeps only the ring. */
  const ringOnly = tier >= 4

  // Runtime AND the external agent it dispatches to are one choice in one
  // dropdown (see `runtime-selector.tsx`) — there is no second "which agent"
  // control to place, and no way to sit on an external lane with nothing
  // selected.
  //
  // `dense` glyphs the name away on every lane; inside the "⋯" popover there
  // is always room for the word, so the menu form is never dense.
  const runtimeChip = (dense: boolean) => (
    <AgentRuntimeSelector
      disabled={isStreaming}
      className={TOOLBAR_CHIP}
      dense={dense}
      // The chip names the sidecar runtime that will really serve the turn, and
      // that is derived from the provider, so it has to be told which one.
      providerId={providerId}
      sessionId={session?.id}
    />
  )

  // Agent Mode composes the preset the Claude SDK runtime runs under; it is
  // meaningless for an external CLI agent, which brings its own.
  //
  // Scoped to THIS session (ADR-0117). The chip it replaced wrote the app-wide
  // default, so it could not change the conversation it sat under once the
  // settings sheet had recorded a per-session choice — and it rendered any
  // session running Minimal/Code/Creator as "General Assistant", because those
  // presets have no `AgentModeConfig` to look up.
  //
  // On the row the preset sits directly on the toolbar and the axes get their
  // own button (`split`); inside the "⋯" overflow there is no row to spread
  // over, so both packings collapse into the single `combined` chip.
  //
  // Mounted on an external runtime too WHEN A SQUAD IS BOUND. The executor axis
  // is not the mode axis: `use-claude-chat-controller` branches to
  // `startSquadRun` above `resolveSendOptions`, so a Squad-bound turn never
  // reaches the runtime at all and the binding keeps working after a switch to
  // an external agent. Hiding the chip there hid the only control that could
  // undo it, leaving a conversation permanently routed to a Squad with nothing
  // on screen saying so.
  const modeChip = (inMenu: boolean) =>
    onBuiltinRuntime || executor.squadId ? (
      <CompositionChip
        sessionId={session?.id}
        disabled={isStreaming}
        layout={inMenu ? "combined" : "split"}
      />
    ) : null

  // Passive indicator, not a control — at tier 0 it sits beside the context
  // ring rather than inside a menu the user has to open to learn whether this
  // turn is sandboxed.
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

  /* `chat.input.effort` REPLACES this chip rather than sitting beside it: a
     plugin dial and the host chip write the same two session fields, and two
     controls for one value on one row is a question the user should never
     have to ask ("which of these wins?"). `min-w-0`, not `shrink-0`: a dial is
     plugin-authored UI and must never be allowed to paint past the group's
     box. */
  const effortDialSlot = (glyphForm: boolean) => (
    <PluginExtensionSlotWithOverflow
      point="chat.input.effort"
      limit={1}
      className="flex min-w-0 items-center"
      overflowLabel={t("pluginExtensionOverflow")}
      fallback={
        <EffortChip
          session={session}
          disabled={isStreaming}
          glyph={glyphForm}
          className={cn(TOOLBAR_CHIP, "max-w-[7.5rem]")}
        />
      }
    />
  )

  // How the turn runs under Router + Fusion (ADR-0188): Auto, Direct, Cascade
  // or Panel. Self-hides while Router + Fusion chat is off.
  const fusionChip = (inMenu: boolean) => (
    <FusionModeChip
      session={session}
      builtinRuntime={onBuiltinRuntime}
      disabled={isStreaming}
      glyph={!inMenu && glyphChips}
      className={cn(TOOLBAR_CHIP, "max-w-[7.5rem]")}
    />
  )

  const permissionChip = (inMenu: boolean) => (
    <PermissionModeIndicator
      onCycle={(next) => setPermissionMode(next, composerSessionId)}
      disabled={isStreaming}
      glyph={!inMenu && glyphChips}
      className={TOOLBAR_CHIP}
    />
  )

  // The per-turn answers: which model, how deeply it thinks, what it may do
  // without asking. These three change between one send and the next, so they
  // are the last to surrender their labels — at tier 2 they go glyph-only
  // rather than folding outright.
  //
  // Every control wears the same quiet chip (`TOOLBAR_CHIP`): no fill, no
  // border, hover-only affordance, and shrinkable so a squeezed row ellipsizes
  // labels instead of letting them spill over the next zone.
  const runConfigChildren = (inMenu: boolean) => (
    <>
      {/* A Squad answers "which model, how deeply" per teammate, from each
          member's own configuration. Leaving the two pickers on the row would
          offer a choice this turn does not take — the shape of the old team
          chat tab, where the model picker was a dead chip and the effort
          selector silently rendered nothing. Say so instead. */}
      {executor.squadId ? (
        <span
          // `inline-flex` is load-bearing: the inner `truncate` only clips
          // inside a flex/grid parent. As a plain inline span the squad name
          // ignored the `max-w` and painted over the status cluster.
          className={cn(
            TOOLBAR_CHIP,
            "inline-flex max-w-[11rem] cursor-default items-center gap-1"
          )}
          title={tComposition("runsOnSquad")}
          data-testid="composer-executor-summary"
        >
          <UsersIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 truncate">
            {executor.squadName ?? tComposition("squadMissing")}
          </span>
        </span>
      ) : (
        <>
          <ModelPicker
            session={session}
            disabled={isStreaming}
            className={cn(TOOLBAR_CHIP, !inMenu && tier >= 3 ? "max-w-[7rem]" : "max-w-[11rem]")}
          />
          {/* Thinking level sits immediately after the model because it qualifies
          it — the pair reads as one answer to "how deeply will this run". It
          self-hides on a surface with no depth control, which is why it can
          live on the permanent row rather than behind the overflow. */}
          {effortDialSlot(!inMenu && glyphChips)}
          {fusionFolded && !inMenu ? null : fusionChip(inMenu)}
        </>
      )}
      {permissionChip(inMenu)}
    </>
  )

  const runConfigGroup = (
    <div
      className="flex min-w-0 flex-nowrap items-center gap-0.5"
      data-testid="composer-execution-controls"
    >
      {runConfigChildren(false)}
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
  // has cost, and the one credential state that would stop the next send. The
  // badge's short form is the tier's doing, not a media query — the viewport
  // knows nothing about how wide this pane is.
  const costBadge = (compactForm: boolean) =>
    session ? (
      <SessionCostBadgeLive
        sessionId={session.id}
        tokensLabel={(input, output) => tHeader("tokensLabel", { input, output })}
        compact={compactForm}
      />
    ) : null
  const credentialBadge = session ? (
    <ComposerCredentialBadge onOpenSettings={onOpenProviderSettings} />
  ) : null

  const contextChip = (ringOnlyForm: boolean) => (
    <ContextUsageIndicator
      modelId={modelId}
      providerId={providerId}
      sdkUsage={sdkUsage}
      ringOnly={ringOnlyForm}
      triggerClassName={cn(TOOLBAR_CHIP, "shrink-0 px-1.5")}
    />
  )

  // Narrow packing only. A Popover, not a DropdownMenu: the agent-mode
  // selector and the plugin slots own their own overlays, and re-mounting
  // those inside a `DropdownMenuItem` desyncs their open state. Every folded
  // control renders its FULL labelled form inside — there is always room in a
  // popover, and a glyph in a menu teaches nothing.
  const foldGroups = (ambientOnRail: boolean) => (
    <div className="flex flex-col gap-2">
      {fusionFolded && <div className="flex flex-wrap items-center gap-2">{fusionChip(true)}</div>}
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {presetControl}
        {modeFolded && modeChip(true)}
        {sandboxIndicator}
      </div>
      {costFolded && !ambientOnRail && (
        <div className="flex flex-wrap items-center gap-2 empty:hidden">{costBadge(false)}</div>
      )}
      <div className="flex flex-wrap items-center gap-2 empty:hidden">{pluginSlots}</div>
    </div>
  )
  const detachedMenu = (ambientOnRail: boolean) => (
    <ToolbarMoreMenu label={t("moreControls")} active={tierActive} disabled={isStreaming}>
      {foldGroups(ambientOnRail)}
    </ToolbarMoreMenu>
  )

  // The in-box layouts pack the same tail unconditionally — that is their
  // design, not the tier's — so this menu exists at every width and the tiers
  // only add to it.
  const packedMenu = (
    <ToolbarMoreMenu label={t("moreControls")} active={tierActive} disabled={isStreaming}>
      <div className="flex flex-col gap-2">
        {fusionFolded && (
          <div className="flex flex-wrap items-center gap-2">{fusionChip(true)}</div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {presetControl}
          {modeChip(true)}
          {sandboxIndicator}
        </div>
        {costFolded && (
          <div className="flex flex-wrap items-center gap-2 empty:hidden">{costBadge(false)}</div>
        )}
        <div className="flex flex-wrap items-center gap-2 empty:hidden">{pluginSlots}</div>
      </div>
    </ToolbarMoreMenu>
  )

  // `focus` folds nearly everything. It is the one skin allowed to hide the
  // per-turn group inline — but hiding is not dropping: the same controls are
  // one click away in the same disclosure the narrow layouts already use, in
  // their full labelled forms.
  const foldedMenu = (
    <ToolbarMoreMenu label={t("moreControls")} active={tierActive} disabled={isStreaming}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">{runConfigChildren(true)}</div>
        <div className="flex flex-wrap items-center gap-2">
          {presetControl}
          {modeChip(true)}
          {runtimeChip(false)}
          {sandboxIndicator}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {costBadge(false)}
          {credentialBadge}
          {contextChip(false)}
        </div>
        <div className="flex flex-wrap items-center gap-2 empty:hidden">{pluginSlots}</div>
      </div>
    </ToolbarMoreMenu>
  )

  // `focus`: the model glyph earns its place because it answers the question
  // asked every turn; the rest is one click away rather than on the row.
  if (layout === "folded") {
    return (
      <div
        ref={rootRef}
        className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted-foreground"
        data-testid="composer-toolbar-embedded"
        data-toolbar-layout="folded"
      >
        <ModelPicker
          session={session}
          disabled={isStreaming}
          className={cn(TOOLBAR_CHIP, "max-w-[9rem]")}
        />
        <span className="ml-auto flex shrink-0 items-center pl-2">{foldedMenu}</span>
      </div>
    )
  }

  // `rail` is `embedded` in a quieter voice: same roster, same order,
  // monospace so it reads as a status line rather than a control strip.
  //
  // Same three zones as the detached row, for the same reason: sitting INSIDE
  // the box this run shares its line with the attach cluster and the send
  // button, and packing every chip against the right edge (`justify-end`)
  // left a dead gap the width of half the composer between the "+" and the
  // model picker, with the ambient numbers crowding the send key. Controls
  // start where the icons end; the read-only tail is pinned right by the auto
  // margin. The fold ladder still applies inside — chips glyph and the cost
  // badge folds as the pane narrows.
  if (layout === "embedded" || layout === "rail") {
    return (
      <div
        ref={rootRef}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted-foreground",
          layout === "rail" && "font-mono text-[10px] tracking-tight"
        )}
        data-testid="composer-toolbar-embedded"
        data-toolbar-layout={layout}
        data-toolbar-tier={tier}
      >
        {runConfigGroup}
        <ToolbarDivider />
        {runtimeChip(glyphChips)}
        <div
          className={cn("ms-auto flex shrink-0 items-center gap-0.5 ps-2", ZONE_RULE)}
          data-testid="composer-status-cluster"
        >
          {!costFolded && costBadge(costShort)}
          {credentialBadge}
          {contextChip(ringOnly)}
          {packedMenu}
        </div>
      </div>
    )
  }

  // Detached (web / desktop, and every narrow pane that keeps the classic
  // skin): ONE row under the box. Narrowing is absorbed by the fold ladder —
  // the zones surrender in priority order into the same "⋯" disclosure —
  // never by a second row: a folded tail only ever held three read-only
  // glyphs against an empty left half, 28px of chrome under the composer on
  // the surface with the least room for it. And never by `shrink-0` labels:
  // a chip that cannot ellipsize overflows its group and paints over the next
  // zone, which is the overlap this ladder exists to prevent.
  const detachedRow = (ambientOnRail: boolean) => (
    <div
      ref={rootRef}
      className="mt-2 flex min-w-0 flex-nowrap items-center gap-x-1 px-1 text-[11px] text-muted-foreground"
      data-testid="composer-footer"
      data-toolbar-layout="detached"
      data-toolbar-tier={tier}
    >
      {leading}
      {runConfigGroup}
      {/* Session shape — how the agent is composed, where it executes, and
          which system prompt it carries. Set once per conversation rather
          than per turn, so this side of the hairline is where the "label only
          when non-default" rule does its work. From tier 2 down the zone
          dissolves: the runtime chip joins the status cluster as a glyph and
          the rest fold into "⋯". */}
      {shapeInline && (
        <>
          <ToolbarDivider />
          <div
            // Yields width three times as fast as the per-turn group beside
            // it: when the pane narrows, "Standard" giving up letters costs
            // less than the model id and the permission mode doing the same.
            className="flex min-w-0 shrink-[3] flex-nowrap items-center gap-0.5"
            data-testid="composer-shape-controls"
          >
            {modeChip(false)}
            {runtimeChip(false)}
            {!sessionFolded && presetControl}
          </div>
        </>
      )}
      {!sessionFolded && (
        <div
          className={cn("flex shrink-0 items-center gap-1 empty:hidden", ZONE_RULE)}
          // A data attribute, not a test id: the chrome budget counts an empty
          // test-id'd element as a control stub, and this zone is empty by
          // default.
          data-toolbar-zone="plugins"
        >
          {pluginSlots}
        </div>
      )}
      {/* Read-only ambient state, pinned right by the auto margin and opened
          by its own rule so it reads as a separate zone rather than as the
          tail of whichever control happens to sit last on the left. The
          cluster stays `shrink-0` — everything inside it is a bounded glyph
          or a tier-capped short form, so it can no longer swallow the row the
          way the labelled version did. */}
      <div
        className={cn("ms-auto flex shrink-0 items-center gap-0.5 ps-1.5 empty:hidden", ZONE_RULE)}
        data-testid="composer-status-cluster"
      >
        {!shapeInline && runtimeChip(true)}
        {!ambientOnRail && !costFolded && costBadge(costShort)}
        {!ambientOnRail && credentialBadge}
        {!ambientOnRail && contextChip(ringOnly)}
        {!sessionFolded && sandboxIndicator}
        {sessionFolded && detachedMenu(ambientOnRail)}
      </div>
    </div>
  )

  if (layout !== "expanded") return detachedRow(false)

  // `full`: the same roster, plus the ambient numbers given a rail of their
  // own so they stop competing with the controls for the one row's width.
  // The rail — not the row's cluster — is where cost, credential and context
  // live in this layout, at full verbosity regardless of tier.
  return (
    <div className="flex min-w-0 flex-col" data-toolbar-layout="expanded" data-toolbar-tier={tier}>
      {detachedRow(true)}
      <div
        className="flex min-w-0 items-center gap-2 px-1 pt-0.5 font-mono text-[10px] text-muted-foreground/80"
        data-testid="composer-ambient-rail"
      >
        {costBadge(false)}
        {credentialBadge}
        {contextChip(false)}
      </div>
    </div>
  )
}

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

/**
 * The hairline between zones. `bg-border` at full strength: at `/50` the rule
 * was a 1px line at half the opacity of an already-quiet token, which on a
 * light theme simply did not render as a line.
 */
const RULE = "h-3.5 w-px shrink-0 bg-border"

/** Thin vertical rule between two zones that are always both present. */
function ToolbarDivider() {
  return <span aria-hidden data-testid="composer-toolbar-divider" className={cn("mx-1", RULE)} />
}

/**
 * The same rule for a zone that may render nothing: drawn as the zone's own
 * `::before`, so `empty:hidden` removes the rule together with the zone.
 */
const ZONE_RULE =
  "before:me-1.5 before:h-3.5 before:w-px before:shrink-0 before:bg-border before:content-['']"

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
