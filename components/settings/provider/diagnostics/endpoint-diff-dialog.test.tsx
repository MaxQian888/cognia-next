/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { EndpointDiffDialog } from "./endpoint-diff-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const props = {
  pendingEndpoint: "https://mirror.example/v1",
  currentEndpoint: "https://api.openai.com/v1",
  onCancel: jest.fn(),
  onConfirm: jest.fn(),
}

describe("EndpointDiffDialog", () => {
  beforeEach(() => jest.clearAllMocks())

  it("stays closed while no endpoint is pending", () => {
    render(<EndpointDiffDialog {...props} pendingEndpoint={null} />)
    expect(screen.queryByText("endpoints.diffTitle")).not.toBeInTheDocument()
  })

  it("shows both endpoints verbatim so a trailing path is visible", () => {
    render(<EndpointDiffDialog {...props} />)
    expect(screen.getByText("https://api.openai.com/v1")).toBeInTheDocument()
    expect(screen.getByText("https://mirror.example/v1")).toBeInTheDocument()
  })

  it("confirms with the pending endpoint", () => {
    render(<EndpointDiffDialog {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "endpoints.confirmApply" }))
    expect(props.onConfirm).toHaveBeenCalledWith("https://mirror.example/v1")
  })

  it("cancels without applying", () => {
    render(<EndpointDiffDialog {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "confirm.cancel" }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })
})
