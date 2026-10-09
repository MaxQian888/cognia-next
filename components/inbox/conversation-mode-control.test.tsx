/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/ui/tooltip")

const mockWriteRoute = jest.fn<string, []>(() => "local")
jest.mock("@/lib/connectors/inbox-writes", () => ({
  useInboxWriteRoute: () => mockWriteRoute(),
}))

const mockEffectiveConfig = jest.fn<unknown, [unknown]>()
jest.mock("@/hooks/connectors/use-im-effective-config", () => ({
  useImEffectiveConfig: (input: unknown) => mockEffectiveConfig(input),
}))

jest.mock("./mode-switcher", () => ({
  ModeSwitcher: (props: { selection: string; targetKind: string; onOpenAdvanced?: () => void }) => (
    <button
      type="button"
      data-testid="mode-switcher-stub"
      data-selection={props.selection}
      data-target={props.targetKind}
      onClick={props.onOpenAdvanced}
    >
      switcher
    </button>
  ),
}))

import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { ConversationModeControl } from "./conversation-mode-control"

function config(autonomy: string, engagement: string, target = "direct") {
  return {
    autonomy: { effective: autonomy },
    engagement: { effective: engagement },
    target: { effective: { kind: target } },
  }
}

const props = {
  conversationKey: "lark:a1:oc",
  sessionId: "s1",
  adapterId: "a1",
  overrideRow: { conversationKey: "lark:a1:oc" } as ConversationOverrideRow,
}

beforeEach(() => {
  mockWriteRoute.mockReturnValue("local")
  mockEffectiveConfig.mockReset().mockReturnValue(config("act", "inline"))
})

describe("ConversationModeControl", () => {
  it("resolves the preset from the live override row through the shared resolver", () => {
    render(<ConversationModeControl {...props} />)
    expect(mockEffectiveConfig).toHaveBeenCalledWith({
      adapterId: "a1",
      override: props.overrideRow,
    })
    expect(screen.getByTestId("mode-switcher-stub")).toHaveAttribute("data-target", "direct")
  })

  it("passes null, not undefined, while the override row is absent", () => {
    render(<ConversationModeControl {...props} overrideRow={undefined} />)
    expect(mockEffectiveConfig).toHaveBeenCalledWith({ adapterId: "a1", override: null })
  })

  it("reads as custom until the adapter row has loaded", () => {
    mockEffectiveConfig.mockReturnValue(undefined)
    render(<ConversationModeControl {...props} />)
    expect(screen.getByTestId("mode-switcher-stub")).toHaveAttribute("data-selection", "custom")
  })

  it("routes the custom destination to the host's settings dialog", async () => {
    const onOpenAdvanced = jest.fn()
    render(<ConversationModeControl {...props} onOpenAdvanced={onOpenAdvanced} />)
    await userEvent.click(screen.getByTestId("mode-switcher-stub"))
    expect(onOpenAdvanced).toHaveBeenCalled()
  })

  it("is a disabled badge where no write can be routed", () => {
    mockWriteRoute.mockReturnValue("unavailable")
    render(<ConversationModeControl {...props} />)
    expect(screen.getByTestId("mode-switcher-disabled")).toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByTestId("mode-switcher-stub")).not.toBeInTheDocument()
    expect(screen.getByText("Mode switching needs a paired host")).toBeInTheDocument()
  })
})
