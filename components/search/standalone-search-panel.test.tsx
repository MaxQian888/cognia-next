/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { StandaloneSearchError } from "@/lib/search/standalone-answer"

import { StandaloneSearchPanel } from "./standalone-search-panel"

function renderPanel(runImpl: jest.Mock) {
  return render(<StandaloneSearchPanel searchOptions={{ runImpl: runImpl as never }} />)
}

describe("StandaloneSearchPanel", () => {
  it("shows the idle hint and a disabled run button initially", () => {
    renderPanel(jest.fn())
    expect(screen.getByTestId("standalone-search-hint")).toBeInTheDocument()
    expect(screen.getByTestId("standalone-search-run")).toBeDisabled()
  })

  it("renders with the default runner when no searchOptions are provided", () => {
    render(<StandaloneSearchPanel />)
    expect(screen.getByTestId("standalone-search-hint")).toBeInTheDocument()
  })

  it("omits the message paragraph when the error has no message", async () => {
    const runImpl = jest.fn().mockRejectedValue(new StandaloneSearchError("answer-failed", ""))
    renderPanel(runImpl)
    fireEvent.change(screen.getByTestId("standalone-search-input"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTestId("standalone-search-run"))
    await waitFor(() => expect(screen.getByTestId("standalone-search-error")).toBeInTheDocument())
    expect(screen.getByTestId("standalone-search-error").querySelector("p")).toBeNull()
  })

  it("renders a cited answer and numbered sources on success", async () => {
    const runImpl = jest.fn().mockResolvedValue({
      query: "q",
      answer: "Synth answer [1].",
      provider: "exa",
      sources: [
        { title: "Alpha", url: "https://alpha.com/p", content: "", score: 1 },
        { title: "Beta", url: "https://www.beta.org/q", content: "", score: 1 },
      ],
    })
    renderPanel(runImpl)
    fireEvent.change(screen.getByTestId("standalone-search-input"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTestId("standalone-search-run"))

    await waitFor(() => expect(screen.getByTestId("standalone-search-answer")).toBeInTheDocument())
    expect(screen.getByTestId("standalone-search-answer")).toHaveTextContent("Synth answer [1].")
    const sources = screen.getByTestId("standalone-search-sources")
    expect(sources).toHaveTextContent("Alpha")
    expect(sources).toHaveTextContent("beta.org")
    expect(screen.getByText("alpha.com")).toBeInTheDocument()
  })

  it("submits on Enter without shift", async () => {
    const runImpl = jest.fn().mockResolvedValue({ query: "q", sources: [], provider: "exa" })
    renderPanel(runImpl)
    const input = screen.getByTestId("standalone-search-input")
    fireEvent.change(input, { target: { value: "hi" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false })
    await waitFor(() => expect(runImpl).toHaveBeenCalled())
  })

  it("does not submit on Shift+Enter", () => {
    const runImpl = jest.fn().mockResolvedValue({ query: "q", sources: [], provider: "exa" })
    renderPanel(runImpl)
    const input = screen.getByTestId("standalone-search-input")
    fireEvent.change(input, { target: { value: "hi" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(runImpl).not.toHaveBeenCalled()
  })

  it("renders an error with a configure link for key-setup failures", async () => {
    const runImpl = jest
      .fn()
      .mockRejectedValue(new StandaloneSearchError("no-model-provider", "missing key"))
    renderPanel(runImpl)
    fireEvent.change(screen.getByTestId("standalone-search-input"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTestId("standalone-search-run"))

    await waitFor(() => expect(screen.getByTestId("standalone-search-error")).toBeInTheDocument())
    expect(screen.getByText("missing key")).toBeInTheDocument()
    expect(screen.getByRole("link")).toHaveAttribute("href", "/me/web-search")
  })

  it("renders a generic error without a configure link", async () => {
    const runImpl = jest
      .fn()
      .mockRejectedValue(new StandaloneSearchError("search-failed", "network"))
    renderPanel(runImpl)
    fireEvent.change(screen.getByTestId("standalone-search-input"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTestId("standalone-search-run"))

    await waitFor(() => expect(screen.getByTestId("standalone-search-error")).toBeInTheDocument())
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })

  it("shows the model-unavailable hint when sources arrive without a model", async () => {
    const runImpl = jest.fn().mockResolvedValue({
      query: "q",
      answer: "provider answer",
      provider: "exa",
      modelUnavailable: true,
      sources: [{ title: "A", url: "https://a.com", content: "", score: 1 }],
    })
    renderPanel(runImpl)
    fireEvent.change(screen.getByTestId("standalone-search-input"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTestId("standalone-search-run"))

    await waitFor(() =>
      expect(screen.getByTestId("standalone-search-model-unavailable")).toBeInTheDocument()
    )
    expect(screen.getByTestId("standalone-search-answer")).toHaveTextContent("provider answer")
  })

  it("falls back to the raw url when a source url is unparseable", async () => {
    const runImpl = jest.fn().mockResolvedValue({
      query: "q",
      answer: undefined,
      provider: "exa",
      sources: [{ title: "", url: "not a valid url", content: "", score: 1 }],
    })
    renderPanel(runImpl)
    fireEvent.change(screen.getByTestId("standalone-search-input"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTestId("standalone-search-run"))
    await waitFor(() => expect(screen.getByTestId("standalone-search-sources")).toBeInTheDocument())
    expect(screen.getAllByText("not a valid url").length).toBeGreaterThan(0)
    // No answer block when answer is absent.
    expect(screen.queryByTestId("standalone-search-answer")).not.toBeInTheDocument()
  })

  it("renders the no-results note when sources are empty", async () => {
    const runImpl = jest.fn().mockResolvedValue({ query: "q", sources: [], provider: "exa" })
    renderPanel(runImpl)
    fireEvent.change(screen.getByTestId("standalone-search-input"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTestId("standalone-search-run"))
    await waitFor(() => expect(screen.getByTestId("standalone-search-result")).toBeInTheDocument())
    expect(screen.queryByTestId("standalone-search-sources")).not.toBeInTheDocument()
  })
})
