/**
 * Cross-provider help / welcome card builder.
 *
 * Produces a platform-agnostic `A2UISegmentContent` that every IM adapter
 * renders through its own A2UI → native mapper (Lark interactive card,
 * Slack Block Kit, Discord embed, …) or degrades to `plainTextMirror` on
 * text-only platforms (QQ official, WeChat OA). It is the single source of
 * truth for what a Cognia bot tells a user about itself — invoked by the
 * bus-level help/welcome dispatcher (`lib/connectors/help/help-dispatch.ts`)
 * on a `/help` text trigger or a member-added / first-inbound welcome.
 *
 * Two modes share the same layout:
 *   - `"help"`    — on-demand, triggered by a help keyword.
 *   - `"welcome"` — proactive, on join / first DM. Prepends an operator-
 *     authored `welcomeText` (or a default) above the capability list.
 *
 * Quick-command buttons carry the `bindingKind: "help_quick_command"` hint
 * (+ `bindingPayload`) so the platform mapper records the binding under that
 * kind. When the user clicks one, `ConnectorBus.dispatchConnectorCallback`
 * short-circuits and re-enters the inbound pipeline as if the command had
 * been typed — see the `help_quick_command` branch in `bus.ts`. Mappers that
 * do not yet honour the hint fall back to the default `callback_query` kind;
 * the click then surfaces as a generic A2UI action (degraded, not broken).
 *
 * Pure function over its inputs — no Dexie / network I/O. The dispatcher
 * owns persistence. Strings default to Chinese (the product's primary
 * locale) and are fully overridable via `labels` so a locale-aware caller
 * can pass translated copy; this mirrors the existing connector-surface
 * builders in `workflow-to-a2ui.ts`, which run in the headless connector
 * runtime where `next-intl` context is unavailable.
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { PlatformSkillCapability } from "@/types/connectors/skill-capability"
import type { InboundActivationPolicy } from "@/types/connectors/policy"
import type { IMQuickCommand, IMQuickCommandAction } from "@/lib/connectors/quick-commands"

export type HelpSurfaceMode = "welcome" | "help"

export type AtResponseStrategy = "always" | "mention_only" | "direct_only"

/**
 * What the card can be told about group admission.
 *
 * Both vocabularies, because the dispatcher now hands it the resolved
 * `InboundActivationPolicy` — the value the bus actually admits on — while the
 * legacy `AtResponseStrategy` spellings stay accepted so a caller holding a
 * pre-migration row still gets a hint rather than a missing label.
 */
export type HelpAtStrategy = AtResponseStrategy | InboundActivationPolicy

export interface HelpSurfaceLabels {
  /** Card title in help mode. */
  helpTitle: string
  /** Card title in welcome mode. `{name}` is replaced with the bot name. */
  welcomeTitle: string
  /** Default intro line for welcome mode when no `welcomeText` is set. `{name}` substituted. */
  welcomeIntro: string
  /** Default intro line for help mode. `{name}` substituted. */
  helpIntro: string
  /** Heading above the quick-command list. */
  quickCommandsHeading: string
  /** Shown instead of the quick-command list when none are configured. */
  noQuickCommands: string
  /** Heading above the built-in skill families list. */
  skillsHeading: string
  /** Heading above the @-strategy hint. */
  atStrategyHeading: string
  /** Per-strategy hint sentence. */
  atStrategy: Record<HelpAtStrategy, string>
  /** Mirror-only prefix for "send X to trigger" (text-only platforms). */
  sendToTrigger: string
}

export const DEFAULT_HELP_SURFACE_LABELS: HelpSurfaceLabels = {
  helpTitle: "使用帮助",
  welcomeTitle: "你好，我是 {name}",
  welcomeIntro: "我是 {name}，可以在这里直接帮你处理任务。下面是你可以让我做的事：",
  helpIntro: "下面是你可以让我做的事：",
  quickCommandsHeading: "快捷指令",
  noQuickCommands: "（管理员尚未配置快捷指令）",
  skillsHeading: "可用技能",
  atStrategyHeading: "如何让我回复",
  atStrategy: {
    always: "在任意消息下我都会回复。",
    mention_each: "在群聊里请 @我 我才会回复；私聊无需 @。",
    mention_activates: "在群聊里 @我 一次即可，之后的追问我也会接着回复；私聊无需 @。",
    direct_only: "请私聊我；群聊中我不会回复。",
    // Legacy spelling of `mention_each`, kept so a pre-migration row still
    // resolves a label instead of rendering `undefined`.
    mention_only: "在群聊里请 @我 我才会回复；私聊无需 @。",
  },
  sendToTrigger: "发送",
}

export interface BuildHelpSurfaceInput {
  /** Stable surface id used for callback-binding action ids. */
  surfaceId: string
  mode: HelpSurfaceMode
  /** Bot display name, substituted into the title / intro. */
  displayName: string
  /** Configured quick commands (already normalised). */
  quickCommands: IMQuickCommand[]
  /** Resolved group-admission policy; omitted ⇒ no hint line. */
  atStrategy?: HelpAtStrategy
  /** Built-in skill families this channel exposes; omitted ⇒ no skills line. */
  skillFamilies?: readonly PlatformSkillCapability[]
  /** Operator-authored welcome intro (welcome mode only). */
  welcomeText?: string
  /** Optional locale-aware label overrides. */
  labels?: Partial<HelpSurfaceLabels>
}

/**
 * A quick-command button's binding descriptor — the dispatcher needs the
 * resolved action to run when the button is clicked, but the binding is
 * written by the per-platform mapper at send time (it reads the hint off
 * the A2UI Button node). We expose the action via `node.bindingPayload` so
 * no second pass is required.
 */
interface HelpQuickCommandPayload {
  action: IMQuickCommandAction
}

function substitute(template: string, name: string): string {
  return template.split("{name}").join(name)
}

/**
 * Build the help / welcome surface. The root is a Card whose children are,
 * in order: an intro Text, the quick-command buttons (or a "none" Text), an
 * optional skills Text, and an optional @-strategy Text. Adapters with
 * native card rendering produce the structured form; the rest fall back to
 * the line-for-line `widget.fallbackText` mirror.
 */
export function buildHelpSurface(input: BuildHelpSurfaceInput): A2UISegmentContent {
  const labels: HelpSurfaceLabels = {
    ...DEFAULT_HELP_SURFACE_LABELS,
    ...input.labels,
    atStrategy: { ...DEFAULT_HELP_SURFACE_LABELS.atStrategy, ...input.labels?.atStrategy },
  }
  const name = input.displayName || "Cognia"
  const title = input.mode === "welcome" ? substitute(labels.welcomeTitle, name) : labels.helpTitle

  const components: Record<string, unknown> = {
    root: { component: "Card", title, children: [] as string[] },
  }
  const childIds: string[] = []
  const mirrorLines: string[] = [`# ${title}`]

  // ── Intro ────────────────────────────────────────────────────────────
  const intro =
    input.mode === "welcome"
      ? input.welcomeText?.trim() || substitute(labels.welcomeIntro, name)
      : substitute(labels.helpIntro, name)
  components.intro = { component: "Text", text: intro }
  childIds.push("intro")
  mirrorLines.push(intro)

  // ── Quick commands ───────────────────────────────────────────────────
  components.qcHeading = {
    component: "Text",
    text: labels.quickCommandsHeading,
    variant: "heading3",
  }
  childIds.push("qcHeading")
  mirrorLines.push("", labels.quickCommandsHeading)

  if (input.quickCommands.length === 0) {
    components.qcNone = { component: "Text", text: labels.noQuickCommands }
    childIds.push("qcNone")
    mirrorLines.push(labels.noQuickCommands)
  } else {
    input.quickCommands.forEach((cmd, i) => {
      const id = `qc_${i}`
      const label = cmd.label?.trim() || cmd.triggerKey
      const payload: HelpQuickCommandPayload = { action: cmd.action }
      components[id] = {
        component: "Button",
        text: label,
        // The action string seeds the deterministic action id; the
        // dispatcher reads the resolved command off `bindingPayload`.
        action: `qc:${cmd.triggerKey}`,
        bindingKind: "help_quick_command",
        bindingPayload: payload,
      }
      childIds.push(id)
      mirrorLines.push(`• ${label} — ${labels.sendToTrigger} ${cmd.triggerKey}`)
    })
  }

  // ── Built-in skills ──────────────────────────────────────────────────
  const families = (input.skillFamilies ?? []).map((s) => s.family).filter(Boolean)
  if (families.length > 0) {
    components.skillsHeading = {
      component: "Text",
      text: labels.skillsHeading,
      variant: "heading3",
    }
    components.skillsBody = { component: "Text", text: families.join("、") }
    childIds.push("skillsHeading", "skillsBody")
    mirrorLines.push("", labels.skillsHeading, families.join("、"))
  }

  // ── @-strategy hint ──────────────────────────────────────────────────
  if (input.atStrategy) {
    const hint = labels.atStrategy[input.atStrategy]
    components.atHeading = {
      component: "Text",
      text: labels.atStrategyHeading,
      variant: "heading3",
    }
    components.atBody = { component: "Text", text: hint }
    childIds.push("atHeading", "atBody")
    mirrorLines.push("", labels.atStrategyHeading, hint)
  }

  ;(components.root as { children: string[] }).children = childIds

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}
