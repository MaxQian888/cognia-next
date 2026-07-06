/**
 * Coverage for the source uploader's file picker. The paste path is exercised
 * indirectly via twin-panel.test.tsx; here we focus on the multi-file +
 * importer-fanout behaviour.
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TwinSourceUploader } from "./twin-source-uploader"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { fetchUrlAsRawSource } from "@/lib/twin/ingest/url-fetcher"
import { processDocumentAsync } from "@cognia/document/document-processor"

// The URL import path hits the network via `fetchUrlAsRawSource`; stub it so the
// component test stays offline and deterministic. The proxy-fetch module is only
// imported (dynamically) inside the Tauri branch — mock it to a harmless factory.
jest.mock("@/lib/twin/ingest/url-fetcher", () => ({
  fetchUrlAsRawSource: jest.fn(),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({
  createProxyFetch: () => jest.fn(),
}))
// The binary-format branch dynamically imports the document processor; stub it
// so the spreadsheet test stays offline and doesn't pull the xlsx parser.
jest.mock("@cognia/document/document-processor", () => ({
  processDocumentAsync: jest.fn(),
}))

const mockFetchUrl = fetchUrlAsRawSource as jest.MockedFunction<typeof fetchUrlAsRawSource>
const mockProcessDocument = processDocumentAsync as jest.MockedFunction<typeof processDocumentAsync>

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().twinSources.clear()
})

function makeFile(name: string, content: string, mimeType = "text/plain"): File {
  return new File([content], name, { type: mimeType })
}

describe("TwinSourceUploader file picker", () => {
  it("creates one twinSources row per markdown file", async () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    const input = screen.getByLabelText(/Pick text files/i) as HTMLInputElement
    const file = makeFile("notes.md", "# Heading\n\nSome content here.")

    await userEvent.upload(input, file)

    await waitFor(async () => {
      const sources = await listTwinSourcesByTwin("twin_alice")
      expect(sources).toHaveLength(1)
      expect(sources[0].format).toBe("markdown")
      expect(sources[0].title).toBe("notes.md")
    })
    expect(await screen.findByText(/Imported 1 source/i)).toBeInTheDocument()
  })

  it("exposes spreadsheet extensions in the file picker accept", () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    const input = screen.getByLabelText(/Pick text files/i) as HTMLInputElement
    // Excel + ODF spreadsheet formats have full parsers in @cognia/document but
    // used to be absent from the uploader's hardcoded accept list, so the picker
    // silently refused to let users select them. The accept string now derives
    // from the ingest dispatcher, so all four spreadsheet extensions appear.
    for (const ext of [".xlsx", ".xls", ".xlsm", ".ods"]) {
      expect(input.accept).toContain(ext)
    }
  })

  it("parses a spreadsheet via the document processor and stores the extracted text", async () => {
    mockProcessDocument.mockResolvedValue({
      id: "tmp",
      filename: "budget.xlsx",
      type: "excel",
      content: "Sheet1\nQ1\t100\nQ2\t120",
      embeddableContent: "Q1 100 Q2 120",
      metadata: { size: 24, lineCount: 3, wordCount: 4, title: "FY24 Budget" },
      parseDiagnostics: [],
    } as Awaited<ReturnType<typeof processDocumentAsync>>)

    render(<TwinSourceUploader twinId="twin_alice" />)
    const input = screen.getByLabelText(/Pick text files/i) as HTMLInputElement
    await userEvent.upload(
      input,
      makeFile(
        "budget.xlsx",
        "binary-bytes",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
    )

    await waitFor(async () => {
      const sources = await listTwinSourcesByTwin("twin_alice")
      expect(sources).toHaveLength(1)
      // Binary path: only the extracted text lands in Dexie, stored as markdown
      // (already-structured) with the original format kept as a tag.
      expect(sources[0].format).toBe("markdown")
      expect(sources[0].kind).toBe("document")
      expect(sources[0].title).toBe("FY24 Budget")
      expect(sources[0].source).toContain("Q1 100")
      expect(sources[0].tags).toEqual(expect.arrayContaining(["xlsx", "extracted"]))
    })
    expect(mockProcessDocument).toHaveBeenCalledWith(
      expect.any(String),
      "budget.xlsx",
      expect.any(ArrayBuffer),
      expect.objectContaining({ extractEmbeddable: true })
    )
  })

  it("fans out an .mbox file into one source per message", async () => {
    const mbox = [
      "From sender@example.com Fri Jan 01 12:00:00 2024",
      "From: alice@example.com",
      "Subject: First",
      "",
      "Body of the first message.",
      "",
      "From sender@example.com Sat Jan 02 12:00:00 2024",
      "From: alice@example.com",
      "Subject: Second",
      "",
      "Body of the second message.",
    ].join("\n")

    render(<TwinSourceUploader twinId="twin_alice" />)
    const input = screen.getByLabelText(/Pick text files/i) as HTMLInputElement
    await userEvent.upload(input, makeFile("inbox.mbox", mbox))

    await waitFor(async () => {
      const sources = await listTwinSourcesByTwin("twin_alice")
      expect(sources).toHaveLength(2)
      expect(sources.every((s) => s.format === "markdown" && s.kind === "email")).toBe(true)
      // From-header participants must be persisted so the redaction pass can
      // seed nameHints — without this the names leak to the cloud embedder.
      expect(sources.every((s) => s.speakers?.includes("alice@example.com"))).toBe(true)
    })
    expect(await screen.findByText(/Imported 2 sources/i)).toBeInTheDocument()
  })

  it("persists chat-export speakers on the imported rows", async () => {
    // Slack export shape (list of message objects with user_profile names).
    const slackExport = JSON.stringify([
      {
        type: "message",
        user: "U01",
        user_profile: { real_name: "Alice Zhang", display_name: "alice" },
        text: "morning all",
        ts: "1700000000.000100",
      },
      {
        type: "message",
        user: "U02",
        user_profile: { real_name: "张伟", display_name: "zw" },
        text: "早上好",
        ts: "1700000001.000100",
      },
    ])

    render(<TwinSourceUploader twinId="twin_alice" />)
    const input = screen.getByLabelText(/Pick text files/i) as HTMLInputElement
    await userEvent.upload(input, makeFile("team-chat.json", slackExport, "application/json"))

    await waitFor(async () => {
      const sources = await listTwinSourcesByTwin("twin_alice")
      expect(sources).toHaveLength(1)
      expect(sources[0].kind).toBe("chat")
      expect(sources[0].speakers).toEqual(expect.arrayContaining(["Alice Zhang", "张伟"]))
    })
  })

  it("leaves speakers undefined for plain text files", async () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    const input = screen.getByLabelText(/Pick text files/i) as HTMLInputElement
    await userEvent.upload(input, makeFile("notes2.md", "# Plain\n\nNo participants here."))

    await waitFor(async () => {
      const sources = await listTwinSourcesByTwin("twin_alice")
      expect(sources).toHaveLength(1)
      expect(sources[0].speakers).toBeUndefined()
    })
  })

  it("flags unknown extensions in the per-file summary without throwing", async () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    const input = screen.getByLabelText(/Pick text files/i) as HTMLInputElement
    // userEvent.upload respects the input's `accept` attribute and silently
    // drops non-matching files; for this test we *want* an unknown-extension
    // file to reach the handler, so go through fireEvent which bypasses the
    // accept gate.
    fireEvent.change(input, { target: { files: [makeFile("strange.zzz", "anything")] } })

    await screen.findByText(/Imported 0 sources/i)
    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Unknown file type/i)
    })
    const sources = await listTwinSourcesByTwin("twin_alice")
    expect(sources).toEqual([])
  })

  it("flags empty files cleanly", async () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    const input = screen.getByLabelText(/Pick text files/i) as HTMLInputElement
    await userEvent.upload(input, makeFile("blank.md", "   "))

    await waitFor(() => {
      expect(screen.getByText(/Imported 0 sources/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/File is empty/i)).toBeInTheDocument()
  })
})

describe("TwinSourceUploader paste path", () => {
  it("persists the pasted body in `source` (not the label)", async () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    const body = "This is the pasted body that must survive to the worker."

    await userEvent.type(screen.getByLabelText(/Title \(optional\)/i), "My label")
    await userEvent.type(screen.getByLabelText(/^Content$/i), body)
    await userEvent.click(screen.getByRole("button", { name: /Save pasted source/i }))

    await waitFor(async () => {
      const sources = await listTwinSourcesByTwin("twin_alice")
      expect(sources).toHaveLength(1)
      // Regression: `source` used to hold the label ("manual paste"), dropping
      // the body so the worker embedded the label instead of the pasted text.
      expect(sources[0].source).toBe(body)
      expect(sources[0].title).toBe("My label")
    })
  })

  it("requires content before saving", async () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    await userEvent.click(screen.getByRole("button", { name: /Save pasted source/i }))

    expect(await screen.findByText(/Paste some content before saving/i)).toBeInTheDocument()
    expect(await listTwinSourcesByTwin("twin_alice")).toEqual([])
  })
})

describe("TwinSourceUploader URL import", () => {
  const TAURI_KEY = "__TAURI_INTERNALS__"

  beforeEach(() => {
    mockFetchUrl.mockReset()
    delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
  })

  async function submitUrl(value: string) {
    await userEvent.type(screen.getByLabelText(/^URL$/i), value)
    await userEvent.click(screen.getByTestId("twin-source-uploader-url-fetch"))
  }

  it("fetches a URL and stores the extracted text as one markdown source", async () => {
    mockFetchUrl.mockResolvedValue({
      url: "https://example.com/article",
      title: "Example Article",
      contentType: "text/html",
      text: "# Example\n\nReadable body text.",
    })
    render(<TwinSourceUploader twinId="twin_alice" />)
    await submitUrl("https://example.com/article")

    await waitFor(async () => {
      const sources = await listTwinSourcesByTwin("twin_alice")
      expect(sources).toHaveLength(1)
      // The reader pre-extracts HTML → we persist `markdown` (not the raw
      // content-type) so the ingest worker doesn't re-parse clean text.
      expect(sources[0].format).toBe("markdown")
      expect(sources[0].kind).toBe("document")
      expect(sources[0].title).toBe("Example Article")
      expect(sources[0].source).toContain("Readable body text.")
      expect(sources[0].tags).toEqual(expect.arrayContaining(["url", "example.com"]))
    })
    expect(await screen.findByTestId("twin-source-uploader-url-imported")).toHaveTextContent(
      "Example Article"
    )
  })

  it("falls back to the hostname when the reader returns no title", async () => {
    mockFetchUrl.mockResolvedValue({
      url: "https://docs.example.org/guide",
      title: "",
      contentType: "text/markdown",
      text: "Some content.",
    })
    render(<TwinSourceUploader twinId="twin_alice" />)
    await submitUrl("https://docs.example.org/guide")

    await waitFor(async () => {
      const sources = await listTwinSourcesByTwin("twin_alice")
      expect(sources).toHaveLength(1)
      expect(sources[0].title).toBe("docs.example.org")
    })
  })

  it("rejects a blank URL without fetching", async () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    await userEvent.click(screen.getByTestId("twin-source-uploader-url-fetch"))

    expect(await screen.findByText(/Enter a URL first/i)).toBeInTheDocument()
    expect(mockFetchUrl).not.toHaveBeenCalled()
    expect(await listTwinSourcesByTwin("twin_alice")).toEqual([])
  })

  it("rejects a malformed URL before fetching", async () => {
    render(<TwinSourceUploader twinId="twin_alice" />)
    await submitUrl("not a url")

    expect(await screen.findByText(/valid URL/i)).toBeInTheDocument()
    expect(mockFetchUrl).not.toHaveBeenCalled()
    expect(await listTwinSourcesByTwin("twin_alice")).toEqual([])
  })

  it("surfaces an empty-extraction result without creating a source", async () => {
    mockFetchUrl.mockResolvedValue({
      url: "https://example.com/empty",
      title: "Empty",
      contentType: "text/html",
      text: "   ",
    })
    render(<TwinSourceUploader twinId="twin_alice" />)
    await submitUrl("https://example.com/empty")

    expect(await screen.findByText(/no readable text/i)).toBeInTheDocument()
    expect(await listTwinSourcesByTwin("twin_alice")).toEqual([])
  })

  it("surfaces a fetch error without creating a source", async () => {
    mockFetchUrl.mockRejectedValue(new Error("network down"))
    render(<TwinSourceUploader twinId="twin_alice" />)
    await submitUrl("https://example.com/boom")

    expect(await screen.findByText(/fetch that URL: network down/i)).toBeInTheDocument()
    expect(await listTwinSourcesByTwin("twin_alice")).toEqual([])
  })

  it("uses the CORS-free proxy fetch and Jina fallback inside Tauri", async () => {
    ;(window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
    mockFetchUrl.mockResolvedValue({
      url: "https://example.com/tauri",
      title: "Via Proxy",
      contentType: "text/html",
      text: "Proxied body.",
    })
    render(<TwinSourceUploader twinId="twin_alice" />)
    await submitUrl("https://example.com/tauri")

    await waitFor(() => {
      expect(mockFetchUrl).toHaveBeenCalledWith(
        "https://example.com/tauri",
        expect.objectContaining({ jinaFallback: true, fetchImpl: expect.any(Function) })
      )
    })
    expect(await listTwinSourcesByTwin("twin_alice")).toHaveLength(1)
  })
})
