import {
  buildHelpSurface,
  DEFAULT_HELP_SURFACE_LABELS,
  type BuildHelpSurfaceInput,
} from "./build-help-surface"
import type { IMQuickCommand } from "@/lib/connectors/quick-commands"

const QC: IMQuickCommand[] = [
  { triggerKey: "agenda", label: "今日日程", action: { type: "slash", value: "/lark agenda" } },
  { triggerKey: "tasks", action: { type: "prompt", value: "列出我的待办" } },
]

function base(overrides: Partial<BuildHelpSurfaceInput> = {}): BuildHelpSurfaceInput {
  return {
    surfaceId: "help_sfc",
    mode: "help",
    displayName: "Cognia Bot",
    quickCommands: QC,
    ...overrides,
  }
}

describe("buildHelpSurface", () => {
  it("renders a help-mode card titled with the help label", () => {
    const s = buildHelpSurface(base({ mode: "help" }))
    const root = s.components.root as { component: string; title: string; children: string[] }
    expect(root.component).toBe("Card")
    expect(root.title).toBe(DEFAULT_HELP_SURFACE_LABELS.helpTitle)
    expect(s.rootId).toBe("root")
    expect(root.children).toContain("intro")
  })

  it("renders a welcome-mode card with the bot name substituted into the title", () => {
    const s = buildHelpSurface(base({ mode: "welcome", displayName: "Helper" }))
    const root = s.components.root as { title: string }
    expect(root.title).toBe("你好，我是 Helper")
  })

  it("uses operator welcomeText as the intro in welcome mode", () => {
    const s = buildHelpSurface(base({ mode: "welcome", welcomeText: "  自定义欢迎语  " }))
    const intro = s.components.intro as { text: string }
    expect(intro.text).toBe("自定义欢迎语")
  })

  it("falls back to the default welcome intro when welcomeText is blank", () => {
    const s = buildHelpSurface(base({ mode: "welcome", displayName: "X", welcomeText: "   " }))
    const intro = s.components.intro as { text: string }
    expect(intro.text).toContain("我是 X")
  })

  it("emits one button per quick command carrying the help_quick_command binding hint", () => {
    const s = buildHelpSurface(base())
    const b0 = s.components.qc_0 as {
      component: string
      text: string
      action: string
      bindingKind: string
      bindingPayload: { action: { type: string; value: string } }
    }
    expect(b0.component).toBe("Button")
    expect(b0.text).toBe("今日日程")
    expect(b0.action).toBe("qc:agenda")
    expect(b0.bindingKind).toBe("help_quick_command")
    expect(b0.bindingPayload.action).toEqual({ type: "slash", value: "/lark agenda" })
  })

  it("labels a quick command by its triggerKey when no label is set", () => {
    const s = buildHelpSurface(base())
    const b1 = s.components.qc_1 as { text: string }
    expect(b1.text).toBe("tasks")
  })

  it("shows the no-commands placeholder when none are configured", () => {
    const s = buildHelpSurface(base({ quickCommands: [] }))
    expect(s.components.qc_0).toBeUndefined()
    const none = s.components.qcNone as { text: string }
    expect(none.text).toBe(DEFAULT_HELP_SURFACE_LABELS.noQuickCommands)
  })

  it("renders the at-strategy hint only when a strategy is supplied", () => {
    const withStrategy = buildHelpSurface(base({ atStrategy: "mention_only" }))
    expect((withStrategy.components.atBody as { text: string }).text).toBe(
      DEFAULT_HELP_SURFACE_LABELS.atStrategy.mention_only
    )
    const without = buildHelpSurface(base())
    expect(without.components.atBody).toBeUndefined()
  })

  it("renders the skills line only when families are supplied", () => {
    const s = buildHelpSurface(
      base({
        skillFamilies: [
          { family: "lark.calendar", mutations: ["read"] },
          { family: "lark.doc", mutations: ["read", "write"] },
        ],
      })
    )
    expect((s.components.skillsBody as { text: string }).text).toBe("lark.calendar、lark.doc")
    const none = buildHelpSurface(base({ skillFamilies: [] }))
    expect(none.components.skillsBody).toBeUndefined()
  })

  it("bakes a plain-text mirror covering title, commands and trigger hints", () => {
    const s = buildHelpSurface(base({ atStrategy: "always" }))
    const mirror = (s.widget as { fallbackText: string }).fallbackText
    expect(mirror).toContain(`# ${DEFAULT_HELP_SURFACE_LABELS.helpTitle}`)
    expect(mirror).toContain("今日日程 — 发送 agenda")
    expect(mirror).toContain("tasks — 发送 tasks")
    expect(mirror).toContain(DEFAULT_HELP_SURFACE_LABELS.atStrategy.always)
  })

  it("honours label overrides including partial at-strategy maps", () => {
    const s = buildHelpSurface(
      base({
        mode: "help",
        atStrategy: "always",
        labels: { helpTitle: "Help", atStrategy: { always: "I always reply." } as never },
      })
    )
    expect((s.components.root as { title: string }).title).toBe("Help")
    expect((s.components.atBody as { text: string }).text).toBe("I always reply.")
  })
})
