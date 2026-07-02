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
