import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrCacheTab } from "./ocr-cache-tab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { putOcrCacheRow } from "@/lib/db/ocr-results"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().ocrResults.clear()
})

async function seedRow(providerId: string, fileSha: string, bytes: number) {
  await putOcrCacheRow({
    id: `${fileSha}|${providerId}|en`,
    fileSha,
    providerId,
    langs: "en",
    result: JSON.stringify({ providerId, pages: [], combinedMarkdown: "", combinedText: "" }),
    createdAt: Date.now() - 60_000,
    bytesIn: bytes,
  })
}

describe("OcrCacheTab", () => {
  it("renders an empty state when no cache rows exist", async () => {
    render(<OcrCacheTab />)
    await waitFor(() => expect(screen.getByTestId("ocr-cache-empty")).toBeInTheDocument())
  })

  it("displays total count and bytes from ocrCacheStats", async () => {
    await seedRow("mistral-ocr", "sha1", 1024)
    await seedRow("mistral-ocr", "sha2", 2048)
    render(<OcrCacheTab />)
    await waitFor(() => {
      expect(screen.getByTestId("ocr-cache-total-count")).toHaveTextContent("2")
      expect(screen.getByTestId("ocr-cache-total-bytes")).toHaveTextContent(/KB/)
    })
  })

  it("lists cached rows", async () => {
    await seedRow("mistral-ocr", "sha1", 1024)
    await seedRow("paddle-ocr", "sha2", 2048)
    render(<OcrCacheTab />)
    await waitFor(() => {
      expect(screen.getByTestId("ocr-cache-row-sha1|mistral-ocr|en")).toBeInTheDocument()
      expect(screen.getByTestId("ocr-cache-row-sha2|paddle-ocr|en")).toBeInTheDocument()
    })
  })

  it("deletes a single row when the trash icon is clicked", async () => {
    await seedRow("mistral-ocr", "sha1", 1024)
    render(<OcrCacheTab />)
    await waitFor(() => screen.getByTestId("ocr-cache-row-sha1|mistral-ocr|en"))
    fireEvent.click(screen.getByTestId("ocr-cache-delete-sha1|mistral-ocr|en"))
    await waitFor(async () => {
      expect(await getDb().ocrResults.count()).toBe(0)
    })
  })

  it("clears all cache when the clear-all button is pressed", async () => {
    await seedRow("mistral-ocr", "sha1", 1024)
    await seedRow("paddle-ocr", "sha2", 2048)
    render(<OcrCacheTab />)
    await waitFor(() => screen.getByTestId("ocr-cache-row-sha1|mistral-ocr|en"))
    fireEvent.click(screen.getByTestId("ocr-cache-clear-all"))
    await waitFor(async () => {
      expect(await getDb().ocrResults.count()).toBe(0)
    })
  })

  it("filters by provider when a provider is selected", async () => {
    const user = userEvent.setup()
    await seedRow("mistral-ocr", "sha1", 1024)
    await seedRow("paddle-ocr", "sha2", 2048)
    render(<OcrCacheTab />)
    await waitFor(() => screen.getByTestId("ocr-cache-row-sha1|mistral-ocr|en"))
    // Open the filter dropdown and pick `paddle-ocr`.
    await user.click(screen.getByTestId("ocr-cache-provider-filter"))
    await user.click(await screen.findByRole("option", { name: "paddle-ocr" }))
    await waitFor(() => {
      expect(screen.queryByTestId("ocr-cache-row-sha1|mistral-ocr|en")).not.toBeInTheDocument()
      expect(screen.getByTestId("ocr-cache-row-sha2|paddle-ocr|en")).toBeInTheDocument()
    })
    // Per-provider clear button should appear.
    expect(screen.getByTestId("ocr-cache-clear-provider")).toBeInTheDocument()
  })
})
