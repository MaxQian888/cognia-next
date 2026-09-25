/**
 * Tests for the chat-copilot capture card (Settings → Automation → Overview).
 * The next-intl jest mock resolves real English strings, so queries use the
 * accessible names a user sees.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { defaultAutomationSettings, type AutomationSettings } from "@/lib/automation/client"
import { ChatCopilotCaptureCard } from "./chat-copilot-capture-card"

function withCopilot(chatCopilot: AutomationSettings["perSurface"]["chatCopilot"]) {
  const base = defaultAutomationSettings()
  return { ...base, perSurface: { ...base.perSurface, chatCopilot } }
}

describe("ChatCopilotCaptureCard", () => {
  it("shows the host default (tier off) as ask-every-time, never as off", () => {
    render(
      <ChatCopilotCaptureCard
        settings={defaultAutomationSettings()}
        onChange={jest.fn()}
        saving={false}
      />
    )
    expect(screen.getByRole("radio", { name: "Ask every time" })).toBeChecked()
    expect(screen.queryByRole("radio", { name: "Off" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Chat apps captured without asking")).not.toBeInTheDocument()
  })

  it("reads a per-call tier as ask-every-time too", () => {
    render(
      <ChatCopilotCaptureCard
        settings={withCopilot({ tier: "perCall" })}
        onChange={jest.fn()}
        saving={false}
      />
    )
    expect(screen.getByRole("radio", { name: "Ask every time" })).toBeChecked()
  })

  it("switching to the allow-list writes the whitelist tier on the copilot surface only", () => {
    const onChange = jest.fn()
    const settings = defaultAutomationSettings()
    render(<ChatCopilotCaptureCard settings={settings} onChange={onChange} saving={false} />)
    fireEvent.click(screen.getByRole("radio", { name: "Allow listed chat apps" }))
    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      perSurface: { ...settings.perSurface, chatCopilot: { tier: "whitelist" } },
    })
    // The agent-facing whitelist is untouched.
    expect(onChange.mock.calls[0][0].whitelist).toEqual(settings.whitelist)
  })

  it("adds trimmed, de-duplicated process names to the surface's own list", () => {
    const onChange = jest.fn()
    render(
      <ChatCopilotCaptureCard
        settings={withCopilot({
          tier: "whitelist",
          whitelist: { processNames: ["QQ"], windowTitlePatterns: ["^Chat"] },
        })}
        onChange={onChange}
        saving={false}
      />
    )
    const input = screen.getByLabelText("Chat apps captured without asking")
    fireEvent.change(input, { target: { value: "  WeChat " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        perSurface: expect.objectContaining({
          chatCopilot: {
            tier: "whitelist",
            whitelist: { processNames: ["QQ", "WeChat"], windowTitlePatterns: ["^Chat"] },
          },
        }),
      })
    )
    expect(input).toHaveValue("")

    onChange.mockClear()
    fireEvent.change(input, { target: { value: "QQ" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("removes an entry and keeps the list when switching back to ask", () => {
    const onChange = jest.fn()
    const list = { processNames: ["QQ", "WeChat"], windowTitlePatterns: [] }
    const { rerender } = render(
      <ChatCopilotCaptureCard
        settings={withCopilot({ tier: "whitelist", whitelist: list })}
        onChange={onChange}
        saving={false}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove QQ" }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        perSurface: expect.objectContaining({
          chatCopilot: {
            tier: "whitelist",
            whitelist: { processNames: ["WeChat"], windowTitlePatterns: [] },
          },
        }),
      })
    )

    rerender(
      <ChatCopilotCaptureCard
        settings={withCopilot({ tier: "whitelist", whitelist: list })}
        onChange={onChange}
        saving={false}
      />
    )
    fireEvent.click(screen.getByRole("radio", { name: "Ask every time" }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        perSurface: expect.objectContaining({
          chatCopilot: { tier: "off", whitelist: list },
        }),
      })
    )
  })

  it("disables the mode choice while saving", () => {
    render(
      <ChatCopilotCaptureCard settings={defaultAutomationSettings()} onChange={jest.fn()} saving />
    )
    expect(screen.getByRole("radio", { name: "Allow listed chat apps" })).toBeDisabled()
  })
})
