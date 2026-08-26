import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ConversationBehaviorEditor } from "./conversation-behavior-editor"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && typeof vars.source === "string" ? `${key}:${vars.source}` : key,
}))

describe("ConversationBehaviorEditor", () => {
  it("shows inheritance and effective sources for conversation scope", () => {
    render(
      <ConversationBehaviorEditor
        scope="conversation"
        value={{}}
        onChange={jest.fn()}
        sources={{ mode: "adapter-default" }}
      />
    )
    expect(screen.getByTestId("behavior-source-mode")).toHaveTextContent(
      "effectiveSource:source_adapter-default"
    )
    expect(screen.getByTestId("behavior-mode")).toHaveTextContent("inherit")
  })

  it("labels an assignment-driven mode with the source_assignment key (slice 1A)", () => {
    render(
      <ConversationBehaviorEditor
        scope="conversation"
        value={{ mode: "manual" }}
        onChange={jest.fn()}
        sources={{ mode: "assignment" }}
      />
    )
    expect(screen.getByTestId("behavior-source-mode")).toHaveTextContent(
      "effectiveSource:source_assignment"
    )
  })

  it("emits one shared draft shape", async () => {
    const onChange = jest.fn()
    render(
      <ConversationBehaviorEditor
        scope="adapter"
        value={{ mode: "auto", activationTtlHours: "" }}
        onChange={onChange}
      />
    )
    await userEvent.type(screen.getByTestId("behavior-ttl"), "12")
    expect(onChange).toHaveBeenLastCalledWith({ mode: "auto", activationTtlHours: "2" })
  })

  describe("behaviour presets", () => {
    it("names the preset the stored axes add up to", () => {
      render(
        <ConversationBehaviorEditor
          scope="adapter"
          value={{ mode: "auto", autonomy: "act", engagement: "background" }}
          onChange={jest.fn()}
        />
      )
      expect(screen.getByTestId("behavior-mode")).toHaveTextContent("preset_delegate")
    })

    // A conversation can hold `confirm` or `autopilot` — through `/mode`, the
    // advanced axes, or an SLA step — and neither is a named preset.
    it("falls back to custom for axes no preset names", () => {
      render(
        <ConversationBehaviorEditor
          scope="adapter"
          value={{ mode: "auto", autonomy: "confirm" }}
          onChange={jest.fn()}
        />
      )
      expect(screen.getByTestId("behavior-mode")).toHaveTextContent("preset_custom")
    })

    it("writes the axes and the legacy mirror together", async () => {
      const onChange = jest.fn()
      const user = userEvent.setup()
      render(<ConversationBehaviorEditor scope="adapter" value={{}} onChange={onChange} />)

      await user.click(screen.getByTestId("behavior-mode"))
      await user.click(screen.getByRole("option", { name: "preset_silent" }))

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ autonomy: "observe", engagement: "human", mode: "manual" })
      )
    })

    it("disables delegate until background work has somewhere to run", async () => {
      const user = userEvent.setup()
      render(<ConversationBehaviorEditor scope="adapter" value={{}} onChange={jest.fn()} />)

      await user.click(screen.getByTestId("behavior-mode"))
      expect(screen.getByRole("option", { name: /preset_delegate/ })).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })

    it("enables delegate once a team carries it", async () => {
      const user = userEvent.setup()
      render(
        <ConversationBehaviorEditor
          scope="adapter"
          value={{}}
          onChange={jest.fn()}
          targetKind="team"
        />
      )

      await user.click(screen.getByTestId("behavior-mode"))
      expect(screen.getByRole("option", { name: "preset_delegate" })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })
  })

  describe("advanced axes", () => {
    it("pins one axis without disturbing the others", async () => {
      const onChange = jest.fn()
      const user = userEvent.setup()
      render(
        <ConversationBehaviorEditor
          scope="conversation"
          value={{ mode: "auto" }}
          onChange={onChange}
        />
      )

      await user.click(screen.getByTestId("behavior-advanced-toggle"))
      await user.click(screen.getByTestId("behavior-autonomy"))
      await user.click(screen.getByRole("option", { name: "autonomy_autopilot" }))

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ autonomy: "autopilot", mode: "auto" })
      )
      // Engagement stays derived so binding a team later still moves the work.
      expect(onChange.mock.calls[0][0].engagement).toBeUndefined()
    })

    it("reports each axis's own provenance", () => {
      render(
        <ConversationBehaviorEditor
          scope="conversation"
          // Pinned axes open the panel on their own — a value an SLA step set
          // is not something to hide behind a collapsed section.
          value={{ autonomy: "observe", engagement: "human" }}
          onChange={jest.fn()}
          sources={{ autonomy: "escalation", engagement: "assignment" }}
        />
      )
      expect(screen.getByTestId("behavior-source-autonomy")).toHaveTextContent(
        "effectiveSource:source_escalation"
      )
      expect(screen.getByTestId("behavior-source-engagement")).toHaveTextContent(
        "effectiveSource:source_assignment"
      )
    })
  })
})
