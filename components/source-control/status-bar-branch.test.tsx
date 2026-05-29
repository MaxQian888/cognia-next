jest.mock("@/hooks/git/use-git-branch-indicator", () => ({
  useGitBranchIndicator: jest.fn(),
}))
const pushMock = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }))

import { fireEvent, render, screen } from "@testing-library/react"
import { useGitBranchIndicator } from "@/hooks/git/use-git-branch-indicator"
import { StatusBarBranch } from "./status-bar-branch"

const indicatorMock = useGitBranchIndicator as jest.Mock

beforeEach(() => {
  indicatorMock.mockReset()
  pushMock.mockReset()
})

describe("StatusBarBranch", () => {
  it("renders nothing on web", () => {
    indicatorMock.mockReturnValue({
      available: false,
      branch: null,
      ahead: 0,
      behind: 0,
      busy: false,
    })
    const { container } = render(<StatusBarBranch />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing without a branch", () => {
    indicatorMock.mockReturnValue({
      available: true,
      branch: null,
      ahead: 0,
      behind: 0,
      busy: false,
    })
    const { container } = render(<StatusBarBranch />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows branch + counts and navigates on click", () => {
    indicatorMock.mockReturnValue({
      available: true,
      branch: "main",
      ahead: 2,
      behind: 1,
      busy: true,
    })
    render(<StatusBarBranch />)
    expect(screen.getByText("main")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByText("1")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("status-branch"))
    expect(pushMock).toHaveBeenCalledWith("/source-control")
  })
})
