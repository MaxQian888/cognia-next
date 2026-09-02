/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/templates/fetch-package", () => ({
  fetchTemplatePackage: jest.fn(),
}))

import { fetchTemplatePackage } from "@/lib/templates/fetch-package"
import { TemplateUrlImportDialog } from "./template-url-import-dialog"

const fetchPackage = fetchTemplatePackage as jest.Mock

describe("TemplateUrlImportDialog", () => {
  it("hands the fetched bytes and the URL to the caller and closes", async () => {
    const bytes = new Uint8Array([1, 2])
    fetchPackage.mockResolvedValue({ bytes, sourceUrl: "https://example.com/t" })
    const onFetched = jest.fn()
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<TemplateUrlImportDialog open onOpenChange={onOpenChange} onFetched={onFetched} />)
    await user.type(screen.getByLabelText("urlLabel"), "https://example.com/t")
    await user.click(screen.getByRole("button", { name: "fetch" }))
    await waitFor(() =>
      expect(onFetched).toHaveBeenCalledWith({ bytes, sourceUrl: "https://example.com/t" })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("shows the guard's own reason instead of a generic failure", async () => {
    fetchPackage.mockRejectedValue(
      new Error("Refusing to fetch a private/loopback address (127.0.0.1).")
    )
    const user = userEvent.setup()
    render(<TemplateUrlImportDialog open onOpenChange={jest.fn()} onFetched={jest.fn()} />)
    await user.type(screen.getByLabelText("urlLabel"), "http://127.0.0.1/t")
    await user.click(screen.getByRole("button", { name: "fetch" }))
    expect(await screen.findByTestId("template-url-import-error")).toHaveTextContent(
      "private/loopback"
    )
  })

  it("keeps the fetch button inert until a URL is typed", async () => {
    render(<TemplateUrlImportDialog open onOpenChange={jest.fn()} onFetched={jest.fn()} />)
    expect(screen.getByRole("button", { name: "fetch" })).toBeDisabled()
  })

  it("does not close when the fetch fails", async () => {
    fetchPackage.mockRejectedValue(new Error("HTTP 404"))
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<TemplateUrlImportDialog open onOpenChange={onOpenChange} onFetched={jest.fn()} />)
    await user.type(screen.getByLabelText("urlLabel"), "https://example.com/missing")
    await user.click(screen.getByRole("button", { name: "fetch" }))
    await screen.findByTestId("template-url-import-error")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
