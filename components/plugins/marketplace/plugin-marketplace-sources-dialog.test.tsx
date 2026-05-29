import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { PluginMarketplaceSourcesDialog } from "./plugin-marketplace-sources-dialog"

const add = jest.fn()
const remove = jest.fn()
let sources: Array<{ id: string; repoRef: string; name: string; addedAt: number }> = []
jest.mock("@/hooks/plugins/use-github-marketplace-sources", () => ({
  useGithubMarketplaceSources: () => ({
    sources,
    add,
    remove,
    entries: [],
    errors: [],
    loading: false,
  }),
}))

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <PluginMarketplaceSourcesDialog open onOpenChange={jest.fn()} />
    </NextIntlClientProvider>
  )
}

describe("PluginMarketplaceSourcesDialog", () => {
  beforeEach(() => {
    add.mockReset()
    remove.mockReset()
    sources = []
  })

  it("shows the empty state with no sources", () => {
    renderDialog()
    expect(screen.getByText("No sources added yet.")).toBeInTheDocument()
  })

  it("validates an empty input", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("add-source-submit"))
    expect(screen.getByRole("alert")).toHaveTextContent("Please enter a repository.")
  })

  it("adds a source and clears the input", async () => {
    add.mockResolvedValue(undefined)
    renderDialog()
    const input = screen.getByLabelText("Marketplace repository")
    fireEvent.change(input, { target: { value: "acme/store" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(add).toHaveBeenCalledWith("acme/store"))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""))
  })

  it("surfaces an add error", async () => {
    add.mockRejectedValue(new Error("no marketplace.json found"))
    renderDialog()
    const input = screen.getByLabelText("Marketplace repository")
    fireEvent.change(input, { target: { value: "acme/empty" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not add source: no marketplace.json found"
      )
    )
  })

  it("lists sources with a remove action", () => {
    sources = [{ id: "acme/store", repoRef: "acme/store", name: "Acme", addedAt: 1 }]
    renderDialog()
    expect(screen.getByTestId("marketplace-source-acme/store")).toHaveTextContent("Acme")
    fireEvent.click(screen.getByRole("button", { name: "Remove Acme" }))
    expect(remove).toHaveBeenCalledWith("acme/store")
  })
})
