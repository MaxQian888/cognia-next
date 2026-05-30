/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const openExternalMock = jest.fn(async (_u: string) => {})
jest.mock("@/lib/tauri/opener", () => ({ openExternal: (u: string) => openExternalMock(u) }))

import { ResourcesCard } from "./resources-card"
import { DOCS_URL, GITHUB_URL, ISSUES_URL } from "@/lib/constants/external-urls"

describe("<ResourcesCard />", () => {
  it("renders all resource links", () => {
    render(<ResourcesCard />)
    for (const key of ["docs", "repo", "issues", "releases", "community"]) {
      expect(screen.getByTestId(`resource-${key}`)).toBeInTheDocument()
    }
  })

  it("opens the matching URL on click", () => {
    render(<ResourcesCard />)
    fireEvent.click(screen.getByTestId("resource-docs"))
    expect(openExternalMock).toHaveBeenCalledWith(DOCS_URL)
    fireEvent.click(screen.getByTestId("resource-repo"))
    expect(openExternalMock).toHaveBeenCalledWith(GITHUB_URL)
    fireEvent.click(screen.getByTestId("resource-issues"))
    expect(openExternalMock).toHaveBeenCalledWith(ISSUES_URL)
  })
})
