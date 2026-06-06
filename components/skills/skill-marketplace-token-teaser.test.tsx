/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

const saveMock = jest.fn(async () => undefined)
let mockToken: string | undefined
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: { settings: Record<string, unknown>; save: typeof saveMock }) => unknown
  ) => selector({ settings: { skillsShToken: mockToken }, save: saveMock }),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { SkillMarketplaceTokenTeaser } from "./skill-marketplace-token-teaser"

beforeEach(() => {
  jest.clearAllMocks()
  mockToken = undefined
})

describe("SkillMarketplaceTokenTeaser", () => {
  it("renders nothing when a token is already configured", () => {
    mockToken = "tok"
    const { container } = render(<SkillMarketplaceTokenTeaser />)
    expect(container).toBeEmptyDOMElement()
  })

  it("saves a pasted token through the settings store", async () => {
    render(<SkillMarketplaceTokenTeaser />)
    expect(screen.getByTestId("skill-marketplace-token-teaser")).toBeInTheDocument()
    const input = screen.getByLabelText("tokenPlaceholder")
    fireEvent.change(input, { target: { value: "  my-token  " } })
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ skillsShToken: "my-token" }))
    expect(toast.success).toHaveBeenCalledWith("saved")
  })

  it("disables save for empty input and surfaces save failures", async () => {
    saveMock.mockRejectedValueOnce(new Error("disk full"))
    render(<SkillMarketplaceTokenTeaser />)
    const button = screen.getByText("save")
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText("tokenPlaceholder"), { target: { value: "t" } })
    fireEvent.click(button)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("disk full"))
  })

  it("links to the skills.sh token docs", () => {
    render(<SkillMarketplaceTokenTeaser />)
    const link = screen.getByText("docsLink").closest("a")
    expect(link).toHaveAttribute("href", "https://skills.sh/docs/api#authentication")
  })
})
