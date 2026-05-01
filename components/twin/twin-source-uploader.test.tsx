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
    })
    expect(await screen.findByText(/Imported 2 sources/i)).toBeInTheDocument()
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
