/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const dialogProps: Array<{
  host: { onOpenSettings: (tab?: string, focus?: string) => void; onNewChat?: () => void; onSelectSession?: (id: string) => void }
  open: boolean
  onOpenChange: (open: boolean) => void
}> = []
jest.mock("@/components/global-search/global-search-dialog", () => ({
  GlobalSearchDialog: (props: (typeof dialogProps)[number]) => {
    dialogProps.push(props)
    return <div data-testid="global-search-dialog-stub" data-open={String(props.open)} />
  },
}))

import { MobileCommandPalette } from "./mobile-command-palette"

describe("MobileCommandPalette (mobile adapter)", () => {
  beforeEach(() => {
    dialogProps.length = 0
  })

  it("mounts the unified dialog controlled by the shell and forwards its host callbacks", () => {
    const onOpenChange = jest.fn()
    const onNewChat = jest.fn()
    const onSelectSession = jest.fn()
    const onOpenSettings = jest.fn()
    const { getByTestId } = render(
      <MobileCommandPalette
        open
        onOpenChange={onOpenChange}
        onNewChat={onNewChat}
        onSelectSession={onSelectSession}
        onOpenSettings={onOpenSettings}
      />
    )
    expect(getByTestId("global-search-dialog-stub")).toHaveAttribute("data-open", "true")
    const props = dialogProps[0]!
    expect(props.onOpenChange).toBe(onOpenChange)
    props.host.onNewChat!()
    expect(onNewChat).toHaveBeenCalled()
    props.host.onSelectSession!("s1")
    expect(onSelectSession).toHaveBeenCalledWith("s1")
    // A focused control degrades to its section on mobile.
    props.host.onOpenSettings("appearance", "language")
    expect(onOpenSettings).toHaveBeenCalledWith("appearance")
  })

  it("keeps the host identity stable while callbacks are stable", () => {
    const callbacks = {
      onOpenChange: jest.fn(),
      onNewChat: jest.fn(),
      onSelectSession: jest.fn(),
      onOpenSettings: jest.fn(),
    }
    const { rerender } = render(<MobileCommandPalette open={false} {...callbacks} />)
    rerender(<MobileCommandPalette open {...callbacks} />)
    expect(dialogProps[0]!.host).toBe(dialogProps[1]!.host)
    expect(dialogProps[1]!.open).toBe(true)
  })
})
