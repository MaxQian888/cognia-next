/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { MobileHomeLayoutSheet } from "./mobile-home-layout-sheet"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const backDismiss = jest.fn()
jest.mock("@/hooks/ui/use-back-dismiss", () => ({
  useBackDismiss: (active: boolean, onDismiss: () => void) => backDismiss(active, onDismiss),
}))

jest.mock("./mobile-quick-actions-editor", () => ({
  MobileQuickActionsEditor: () => <div data-testid="mobile-quick-actions-editor" />,
}))

beforeEach(() => {
  backDismiss.mockClear()
})

describe("<MobileHomeLayoutSheet />", () => {
  it("renders the editor when open", () => {
    render(<MobileHomeLayoutSheet open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("mobile-quick-actions-editor")).toBeInTheDocument()
  })

  it("mounts nothing while closed", () => {
    render(<MobileHomeLayoutSheet open={false} onOpenChange={jest.fn()} />)
    expect(screen.queryByTestId("mobile-quick-actions-editor")).toBeNull()
  })

  // Android hardware back has to close the sheet rather than leave the route.
  it("arms the back-dismiss only while open", () => {
    const onOpenChange = jest.fn()
    render(<MobileHomeLayoutSheet open onOpenChange={onOpenChange} />)
    expect(backDismiss).toHaveBeenCalledWith(true, expect.any(Function))
    backDismiss.mock.calls[0][1]()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
