import { render, screen } from "@testing-library/react"
import { TwinAddSourceDialog } from "./add-source-dialog"

jest.mock("./add-source-flow", () => ({
  AddSourceFlow: ({ twinId }: { twinId: string }) => <div data-testid="mock-flow">{twinId}</div>,
}))

describe("TwinAddSourceDialog", () => {
  it("renders the flow inside a dialog when open", () => {
    render(<TwinAddSourceDialog twinId="twin_a" open onOpenChange={() => {}} />)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByTestId("mock-flow")).toHaveTextContent("twin_a")
    expect(screen.getByText(/Add sources/i)).toBeInTheDocument()
  })

  it("renders nothing while closed", () => {
    render(<TwinAddSourceDialog twinId="twin_a" open={false} onOpenChange={() => {}} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByTestId("mock-flow")).not.toBeInTheDocument()
  })
})
