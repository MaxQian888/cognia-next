import { fireEvent, render, screen } from "@testing-library/react"
import { ToolCallCard, ToolCallList } from "./tool-call-card"
import type { ToolCallEntry } from "@/lib/agent-team/team-runtime-dispatcher"

describe("ToolCallCard", () => {
  it("renders the tool name and complete status by default", () => {
    const call: ToolCallEntry = {
      id: "t1",
      name: "ls",
      input: '{"dir":"/"}',
      output: "file1\nfile2",
      status: "complete",
    }
    render(<ToolCallCard call={call} />)
    expect(screen.getByText("ls")).toBeInTheDocument()
    expect(screen.getByText("complete")).toBeInTheDocument()
    expect(screen.queryByTestId("tool-call-card-t1-body")).not.toBeInTheDocument()
  })

  it("toggles details on click and shows input + output", () => {
    const call: ToolCallEntry = {
      id: "t1",
      name: "ls",
      input: '{"dir":"/"}',
      output: "file1\nfile2",
      status: "complete",
    }
    render(<ToolCallCard call={call} />)
    fireEvent.click(screen.getByRole("button", { name: /Toggle details for ls/ }))
    const body = screen.getByTestId("tool-call-card-t1-body")
    expect(body).toBeInTheDocument()
    expect(body).toHaveTextContent('{"dir":"/"}')
    expect(body).toHaveTextContent("file1")
    expect(body).toHaveTextContent("file2")
  })

  it("renders error status with destructive border", () => {
    const call: ToolCallEntry = {
      id: "t2",
      name: "fetch",
      output: "boom",
      status: "error",
    }
    render(<ToolCallCard call={call} />)
    const card = screen.getByTestId("tool-call-card-t2")
    expect(card).toHaveAttribute("data-status", "error")
    expect(screen.getByText("error")).toBeInTheDocument()
  })

  it("shows running spinner status and disables toggle when no details", () => {
    const call: ToolCallEntry = { id: "t3", name: "search", status: "running" }
    render(<ToolCallCard call={call} />)
    expect(screen.getByTestId("tool-call-card-t3")).toHaveAttribute("data-status", "running")
    const button = screen.getByRole("button", { name: /Toggle details for search/ })
    expect(button).toBeDisabled()
  })

  it("truncates very long output preview", () => {
    const longOutput = "x".repeat(2000)
    const call: ToolCallEntry = { id: "t4", name: "huge", output: longOutput, status: "complete" }
    render(<ToolCallCard call={call} />)
    fireEvent.click(screen.getByRole("button", { name: /Toggle details for huge/ }))
    const body = screen.getByTestId("tool-call-card-t4-body")
    expect(body.textContent).toContain("…")
    expect(body.textContent?.length).toBeLessThan(longOutput.length)
  })
})

describe("ToolCallList", () => {
  it("renders one card per call", () => {
    const calls: ToolCallEntry[] = [
      { id: "a", name: "ls", status: "complete", output: "a" },
      { id: "b", name: "cat", status: "running" },
    ]
    render(<ToolCallList calls={calls} />)
    expect(screen.getByTestId("tool-call-card-a")).toBeInTheDocument()
    expect(screen.getByTestId("tool-call-card-b")).toBeInTheDocument()
  })

  it("renders nothing for empty array", () => {
    const { container } = render(<ToolCallList calls={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
