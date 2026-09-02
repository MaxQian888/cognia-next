import { render, screen } from "@testing-library/react"

import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { CompositionPicker } from "./composition-picker"
import compositionMessages from "@/i18n/messages/en/agentComposition.json"
import zhCompositionMessages from "@/i18n/messages/zh-CN/agentComposition.json"
import agentModeMessages from "@/i18n/messages/en/agentMode.json"
import { AGENT_ORCHESTRATION_POLICIES } from "@cognia/agent-config-types/agent-composition"
import {
  CODE_PRESET,
  CREATOR_PRESET,
  MINIMAL_PRESET,
  STANDARD_PRESET,
  presetFromAgentMode,
} from "@/lib/agent/composition/preset-catalog"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"

// The global next-intl mock resolves keys from the generated aggregate, which
// lags the split sources on dev. This one reads the files the keys are
// authored in, so a new key is testable without regenerating the bundle.
jest.mock("next-intl", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const messages: Record<string, unknown> = {
    agentComposition: require("@/i18n/messages/en/agentComposition.json"),
    agentMode: require("@/i18n/messages/en/agentMode.json"),
  }
  /* eslint-enable @typescript-eslint/no-require-imports */
  const resolve = (root: unknown, dotted: string): unknown =>
    dotted.split(".").reduce<unknown>((cursor, segment) => {
      if (cursor && typeof cursor === "object" && segment in (cursor as object)) {
        return (cursor as Record<string, unknown>)[segment]
      }
      return undefined
    }, root)
  const plural = (template: string, values: Record<string, unknown>): string =>
    template.replace(
      /\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g,
      (_match, name: string, body: string) => {
        const value = Number(values[name])
        const branches = new Map<string, string>()
        const re = /(=\d+|\w+)\s*\{([^{}]*)\}/g
        let m: RegExpExecArray | null
        while ((m = re.exec(body))) branches.set(m[1], m[2])
        const chosen =
          branches.get(`=${value}`) ??
          (value === 1 ? branches.get("one") : undefined) ??
          branches.get("other") ??
          ""
        return chosen.replace(/#/g, String(value))
      }
    )
  const make = (namespace?: string) => {
    const root = namespace ? resolve(messages, namespace) : messages
    const t = (key: string, values: Record<string, unknown> = {}) => {
      const found = resolve(root, key)
      if (typeof found !== "string") return namespace ? `${namespace}.${key}` : key
      return plural(found, values).replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in values ? String(values[name]) : whole
      )
    }
    t.has = (key: string) => typeof resolve(root, key) === "string"
    t.rich = t
    t.raw = (key: string) => resolve(root, key)
    return t
  }
  return {
    useTranslations: make,
    useLocale: () => "en",
    NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
  }
})

const hostProfile = jest.fn<string, []>(() => "desktop")
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => hostProfile(),
}))

const messages = {
  agentComposition: compositionMessages,
  agentMode: agentModeMessages,
}

const CUSTOM_PRESET = presetFromAgentMode(
  {
    id: "my-reviewer",
    type: "custom",
    name: "My Reviewer",
    description: "Reviews things carefully",
    icon: "Sparkles",
    systemPrompt: "Be exacting.",
  },
  "custom"
)

const PRESETS = [STANDARD_PRESET, MINIMAL_PRESET, CODE_PRESET, CREATOR_PRESET, CUSTOM_PRESET]

function renderPicker(
  selection: AgentCompositionSelectionV1,
  props: Partial<React.ComponentProps<typeof CompositionPicker>> = {}
) {
  const onChange = jest.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CompositionPicker presets={PRESETS} selection={selection} onChange={onChange} {...props} />
    </NextIntlClientProvider>
  )
  return { ...view, onChange }
}

describe("CompositionPicker", () => {
  it("labels the preset control and shows the current selection", () => {
    renderPicker({ presetId: "standard" })

    expect(screen.getByText("Preset")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /preset/i })).toHaveTextContent("Standard")
  })

  // The whole point of the app-side catalog: a user's own mode is selectable.
  it("offers a custom preset alongside the built-ins", async () => {
    renderPicker({ presetId: "standard" })

    await userEvent.click(screen.getByRole("combobox", { name: /preset/i }))

    expect(await screen.findByRole("option", { name: /My Reviewer/ })).toBeInTheDocument()
  })

  it("reports the chosen preset without touching the other axes", async () => {
    const { onChange } = renderPicker({ presetId: "standard", authority: "plan" })

    await userEvent.click(screen.getByRole("combobox", { name: /preset/i }))
    await userEvent.click(await screen.findByRole("option", { name: /My Reviewer/ }))

    expect(onChange).toHaveBeenCalledWith({ presetId: "my-reviewer", authority: "plan" })
  })

  it("hides developer-only presets unless developer mode is on", async () => {
    const { unmount } = renderPicker({ presetId: "standard" })
    await userEvent.click(screen.getByRole("combobox", { name: /preset/i }))
    expect(screen.queryByRole("option", { name: /Creator/ })).not.toBeInTheDocument()
    unmount()

    renderPicker({ presetId: "standard" }, { developerMode: true })
    await userEvent.click(screen.getByRole("combobox", { name: /preset/i }))
    expect(await screen.findByRole("option", { name: /Creator/ })).toBeInTheDocument()
  })

  it("keeps the advanced axes hidden until asked for", async () => {
    const { rerender } = renderPicker({ presetId: "standard" })
    expect(screen.queryByRole("combobox", { name: /permission/i })).not.toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <CompositionPicker
          presets={PRESETS}
          selection={{ presetId: "standard" }}
          onChange={jest.fn()}
          advancedOpen
        />
      </NextIntlClientProvider>
    )

    expect(screen.getByRole("combobox", { name: /permission/i })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /tools/i })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /orchestration/i })).toBeInTheDocument()
  })

  it("resolves every orchestration option message", () => {
    for (const policy of AGENT_ORCHESTRATION_POLICIES) {
      expect(compositionMessages.axis.orchestration.options).toHaveProperty(policy)
      expect(zhCompositionMessages.axis.orchestration.options).toHaveProperty(policy)
    }
  })

  it("reports an axis change without disturbing the preset", async () => {
    const { onChange } = renderPicker({ presetId: "standard" }, { advancedOpen: true })

    await userEvent.click(screen.getByRole("combobox", { name: /permission/i }))
    await userEvent.click(await screen.findByRole("option", { name: "Read-only" }))

    expect(onChange).toHaveBeenCalledWith({ presetId: "standard", authority: "plan" })
  })

  // Choosing the preset's own recommendation back is "inherit", not a pin — the
  // axis has to clear rather than freeze the preset's current value.
  it("clears an axis when the inherit option is chosen", async () => {
    const { onChange } = renderPicker(
      { presetId: "standard", authority: "plan" },
      { advancedOpen: true }
    )

    await userEvent.click(screen.getByRole("combobox", { name: /permission/i }))
    await userEvent.click(await screen.findByRole("option", { name: "Preset default · Standard" }))

    expect(onChange).toHaveBeenCalledWith({ presetId: "standard", authority: undefined })
  })

  it("describes the active preset under the selector", () => {
    renderPicker({ presetId: "standard" })

    expect(screen.getByTestId("composition-preset-description")).toHaveTextContent(
      "General purpose assistant with the default tools"
    )
  })

  it("falls back to the preset's own description when no translation exists", () => {
    renderPicker({ presetId: "my-reviewer" })

    expect(screen.getByTestId("composition-preset-description")).toHaveTextContent(
      "Reviews things carefully"
    )
  })

  it("counts pinned axes on the advanced toggle and marks them in the summary", () => {
    renderPicker({ presetId: "standard", authority: "plan", orchestration: "subagent" })

    expect(screen.getByTestId("composition-override-count")).toHaveTextContent("2 overrides")
    expect(screen.getByTestId("composition-pinned-authority")).toBeInTheDocument()
    expect(screen.getByTestId("composition-pinned-orchestration")).toBeInTheDocument()
    expect(screen.queryByTestId("composition-pinned-toolPresentation")).not.toBeInTheDocument()
  })

  it("shows no override badge when every axis follows the preset", () => {
    renderPicker({ presetId: "standard" })

    expect(screen.queryByTestId("composition-override-count")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  // The composer's split chip owns the preset control; the picker then IS the
  // advanced panel — no toggle to find, axes always on.
  it("drops the preset control and the toggle when the host owns the preset", () => {
    renderPicker({ presetId: "standard" }, { presetControl: false })

    expect(screen.queryByRole("combobox", { name: /preset/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Advanced" })).not.toBeInTheDocument()
    expect(screen.queryByTestId("composition-preset-description")).not.toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /permission/i })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /tools/i })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /orchestration/i })).toBeInTheDocument()
    expect(screen.getByTestId("composition-summary")).toHaveTextContent("Ask each time")
  })

  it("lists each resolved axis as a labelled summary row", () => {
    renderPicker({ presetId: "standard" })

    const summary = screen.getByTestId("composition-summary")
    expect(summary).toHaveTextContent("Permission")
    expect(summary).toHaveTextContent("Ask each time")
    expect(summary).toHaveTextContent("Tools")
    expect(summary).toHaveTextContent("Native tools")
    expect(summary).toHaveTextContent("Orchestration")
    expect(summary).toHaveTextContent("Single agent")
  })

  it("marks an experimental preset in the list", async () => {
    renderPicker({ presetId: "standard" }, { developerMode: true, includeExperimental: true })

    await userEvent.click(screen.getByRole("combobox", { name: /preset/i }))
    const codeOption = await screen.findByRole("option", { name: /Code/ })

    expect(codeOption).toHaveTextContent("Experimental")
  })

  it("marks a developer-only preset in the list", async () => {
    renderPicker({ presetId: "standard" }, { developerMode: true })

    await userEvent.click(screen.getByRole("combobox", { name: /preset/i }))

    expect(await screen.findByRole("option", { name: /Creator/ })).toHaveTextContent("Developer")
  })

  it("asks the host to open the advanced panel", async () => {
    const onAdvancedOpenChange = jest.fn()
    renderPicker({ presetId: "standard" }, { onAdvancedOpenChange })

    await userEvent.click(screen.getByRole("button", { name: "Advanced" }))

    expect(onAdvancedOpenChange).toHaveBeenCalledWith(true)
  })

  // The summary must describe what will RUN, not what was asked for — that is
  // the reason it exists rather than echoing the selection back.
  it("summarises the resolved axes, not the requested ones", () => {
    renderPicker({ presetId: "minimal", authority: "bypassPermissions" })

    // Minimal caps authority at `plan`, so the summary reads Read-only even
    // though the selection asked to bypass permissions.
    expect(screen.getByText(/Read-only/)).toBeInTheDocument()
    expect(screen.getByText(/Permission lowered to plan/)).toBeInTheDocument()
  })

  it("warns when the host cannot offer code tools and falls back to native", () => {
    renderPicker(
      { presetId: "standard", toolPresentation: "code" },
      { supportedToolPresentations: ["native"] }
    )

    expect(screen.getByText(/Code tools need a strict sandbox/)).toBeInTheDocument()
  })

  it("warns when the selected preset no longer exists", () => {
    renderPicker({ presetId: "deleted-mode" })

    expect(screen.getByText(/no longer available/)).toBeInTheDocument()
  })

  // With the preset gone there is nothing to name as the inherit source, so the
  // axes fall back to the generic label rather than rendering "undefined".
  it("labels the inherit option generically when the preset is gone", () => {
    renderPicker({ presetId: "deleted-mode" }, { advancedOpen: true })

    // Three axes, each showing the fallback as its current (inherited) value.
    expect(screen.getAllByText("Preset default")).toHaveLength(3)
    // And no description, since there is no preset to describe.
    expect(screen.queryByTestId("composition-preset-description")).not.toBeInTheDocument()
  })

  it("disables every control while disabled", () => {
    renderPicker({ presetId: "standard" }, { disabled: true, advancedOpen: true })

    for (const combobox of screen.getAllByRole("combobox")) {
      expect(combobox).toBeDisabled()
    }
  })

  describe("independent reviewer availability", () => {
    beforeEach(() => hostProfile.mockReturnValue("desktop"))

    it("offers the independent reviewer on a shell that owns the agent", async () => {
      const { onChange } = renderPicker({ presetId: "standard" }, { advancedOpen: true })
      await userEvent.click(screen.getByRole("combobox", { name: /orchestration/i }))
      const option = await screen.findByRole("option", { name: /Independent reviewer/ })
      expect(option).not.toHaveAttribute("aria-disabled", "true")
      expect(option).not.toHaveTextContent("Not built yet")
      await userEvent.click(option)
      expect(onChange).toHaveBeenCalledWith({
        presetId: "standard",
        orchestration: "verified-fresh-agent",
      })
    })

    // Three-axis dormancy: the option stays listed on a companion shell,
    // disabled, with the reason the follow-up itself refuses with.
    it.each(["mobile-companion", "cloud-companion"])(
      "keeps it visible but disabled with a reason on %s",
      async (profile) => {
        hostProfile.mockReturnValue(profile)
        renderPicker({ presetId: "standard" }, { advancedOpen: true })
        await userEvent.click(screen.getByRole("combobox", { name: /orchestration/i }))
        const option = await screen.findByRole("option", { name: /Independent reviewer/ })
        expect(option).toHaveAttribute("aria-disabled", "true")
        expect(option).toHaveTextContent(
          compositionMessages.axis.orchestration.unavailable.companionShell
        )
        expect(zhCompositionMessages.axis.orchestration.unavailable).toHaveProperty(
          "companionShell"
        )
      }
    )
  })
})
