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

jest.mock("@/components/mobile/glance/mobile-glance-editor", () => ({
  MobileGlanceEditor: () => <div data-testid="mobile-glance-editor" />,
}))

beforeEach(() => {
  backDismiss.mockClear()
})

describe("<MobileHomeLayoutSheet />", () => {
  it("renders the glance layout editor, titled, when open", () => {
    render(<MobileHomeLayoutSheet open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("mobile-glance-editor")).toBeInTheDocument()
    expect(screen.getByText("editorTitle")).toBeInTheDocument()
    expect(screen.getByText("editorDescription")).toBeInTheDocument()
  })

  it("mounts nothing while closed", () => {
    render(<MobileHomeLayoutSheet open={false} onOpenChange={jest.fn()} />)
    expect(screen.queryByTestId("mobile-glance-editor")).toBeNull()
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
