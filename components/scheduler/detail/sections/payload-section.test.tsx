import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { PayloadSection, type PayloadReferenceResolver } from "./payload-section"

const copy = jest.fn(async () => true)
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, isCopying: false, copy }),
}))

function resolver(names: Record<string, string | null>): PayloadReferenceResolver {
  return jest.fn(async (ref, id) => names[`${ref}:${id}`] ?? null)
}

describe("PayloadSection", () => {
  beforeEach(() => copy.mockClear())

  it("names the task type, shows the prompt in full width and resolves the character", async () => {
    const resolve = resolver({ "character:c1": "Research Analyst" })
    render(
      <PayloadSection
        task={{
          id: "t1",
          type: "agent",
          payload: { prompt: "Summarise the inbox", characterId: "c1", maxTurns: 4 },
        }}
        resolveReference={resolve}
      />
    )
    expect(screen.getByText("AI Agent")).toBeInTheDocument()
    expect(screen.getByTestId("payload-fact-prompt-body")).toHaveTextContent("Summarise the inbox")
    expect(screen.getByTestId("payload-fact-maxTurns")).toHaveTextContent("4")
    await waitFor(() =>
      expect(screen.getByTestId("payload-fact-character")).toHaveTextContent("Research Analyst")
    )
    // The id stays beside the name, for a person who has two characters with one name.
    expect(screen.getByTestId("payload-fact-character")).toHaveTextContent("c1")
    expect(resolve).toHaveBeenCalledWith("character", "c1")
  })

  it("says when a referenced record no longer exists", async () => {
    render(
      <PayloadSection
        task={{ id: "t1", type: "workflow", payload: { workflowId: "gone" } }}
        resolveReference={resolver({})}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId("payload-missing-ref")).toHaveTextContent("gone (no longer exists)")
    )
  })

  it("links a resolved workflow to its editor", async () => {
    render(
      <PayloadSection
        task={{ id: "t1", type: "workflow", payload: { workflowId: "wf 1" } }}
        resolveReference={resolver({ "workflow:wf 1": "Nightly ETL" })}
      />
    )
    const link = await screen.findByTestId("payload-workflow-link")
    expect(link).toHaveAttribute("href", "/workflows/editor?id=wf%201")
    expect(link).toHaveTextContent("Nightly ETL")
  })

  it("clamps a long prompt behind a toggle and copies it whole", () => {
    const prompt = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")
    render(
      <PayloadSection
        task={{ id: "t1", type: "chat", payload: { prompt } }}
        resolveReference={resolver({})}
      />
    )
    const body = screen.getByTestId("payload-fact-prompt-body")
    expect(body).toHaveClass("line-clamp-6")
    fireEvent.click(screen.getByTestId("payload-fact-prompt-toggle"))
    expect(body).not.toHaveClass("line-clamp-6")
    expect(screen.getByTestId("payload-fact-prompt-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    fireEvent.click(screen.getAllByTestId("payload-copy")[0])
    expect(copy).toHaveBeenCalledWith(prompt)
  })

  it("shows the stored payload for a type it has no reading for", () => {
    render(
      <PayloadSection
        task={{ id: "t1", type: "twin", payload: { mode: "distill" } } as never}
        resolveReference={resolver({})}
      />
    )
    fireEvent.click(screen.getByTestId("payload-raw-toggle"))
    expect(screen.getByTestId("payload-raw")).toHaveTextContent('"mode": "distill"')
  })

  it("says so when the task stores nothing at all", () => {
    render(
      <PayloadSection
        task={{ id: "t1", type: "backup", payload: undefined }}
        resolveReference={resolver({})}
      />
    )
    expect(screen.getByTestId("payload-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("payload-raw-toggle")).toBeNull()
  })
})
