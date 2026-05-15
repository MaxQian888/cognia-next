/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

// Mock the underlying slot so we can assert what props the wrapper passes
// without dragging the real extension registry in.
const slotMock = jest.fn(({ point, context, className }: Record<string, unknown>) => (
  <div
    data-testid="slot-mock"
    data-point={point as string}
    data-class={className as string}
    data-context={JSON.stringify(context)}
  />
))

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: (props: Record<string, unknown>) => slotMock(props),
}))

import { InboxComposerActionsHost } from "./inbox-composer-actions-host"

beforeEach(() => slotMock.mockClear())

describe("InboxComposerActionsHost", () => {
  it("mounts the inbox.composer.actions slot", () => {
    render(
      <InboxComposerActionsHost
        conversationKey="telegram:tg-1:42"
        adapterId="tg-1"
        platform="telegram"
        sessionId="ses_x"
      />
    )
    const props = slotMock.mock.calls[0][0] as Record<string, unknown>
    expect(props.point).toBe("inbox.composer.actions")
  })

  it("forwards conversation context to the slot", () => {
    render(
      <InboxComposerActionsHost
        conversationKey="discord:ds-1:c1"
        adapterId="ds-1"
        platform="discord"
        sessionId="ses_y"
      />
    )
    const props = slotMock.mock.calls[0][0] as Record<string, unknown>
    expect(props.context).toEqual({
      conversationKey: "discord:ds-1:c1",
      adapterId: "ds-1",
      platform: "discord",
      sessionId: "ses_y",
    })
  })

  it("uses a default empty:hidden className when not overridden", () => {
    render(
      <InboxComposerActionsHost conversationKey="k" adapterId="a" platform="lark" sessionId="s" />
    )
    const props = slotMock.mock.calls[0][0] as Record<string, unknown>
    expect(String(props.className)).toContain("empty:hidden")
  })

  it("respects an explicit className override", () => {
    render(
      <InboxComposerActionsHost
        conversationKey="k"
        adapterId="a"
        platform="slack"
        sessionId="s"
        className="custom-classname"
      />
    )
    const props = slotMock.mock.calls[0][0] as Record<string, unknown>
    expect(props.className).toBe("custom-classname")
  })
})
