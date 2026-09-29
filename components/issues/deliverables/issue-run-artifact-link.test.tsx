/**
 * @jest-environment jsdom
 */

const mockPush = jest.fn()
const mockOpen = jest.fn()
const mockToastError = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }))
jest.mock("@/lib/files-library/open", () => ({
  openArtifactInSession: (...args: unknown[]) => mockOpen(...args),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { IssueRunArtifactLink } from "./issue-run-artifact-link"

beforeEach(() => jest.clearAllMocks())

it("renders URLs and routes as anchors, external ones in a new tab", () => {
  const { rerender } = render(
    <IssueRunArtifactLink artifact={{ label: "PR #1", href: "https://github.com/a/b/pull/1" }} />
  )
  expect(screen.getByTestId("issue-run-artifact")).toHaveAttribute("target", "_blank")
  rerender(<IssueRunArtifactLink artifact={{ label: "Session", href: "/?session=s1" }} />)
  expect(screen.getByTestId("issue-run-artifact")).not.toHaveAttribute("target")
})

it("opens a Cognia artifact in its conversation, and says so when that is gone", async () => {
  mockOpen.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  render(
    <IssueRunArtifactLink
      artifact={{ label: "report.csv", href: "artifact:a1", artifactId: "a1", sessionId: "s1" }}
    />
  )
  fireEvent.click(screen.getByTestId("issue-run-artifact"))
  await waitFor(() => expect(mockOpen).toHaveBeenCalledWith("a1", "s1", { push: mockPush }))
  expect(mockToastError).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId("issue-run-artifact"))
  await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("deliverables.conversationGone"))
})
