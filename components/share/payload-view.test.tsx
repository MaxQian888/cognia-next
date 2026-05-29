import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { PayloadView } from "./payload-view"
import type { SharePayload } from "@/lib/share/types"

// jsdom doesn't implement object URLs; the backup card needs them.
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    writable: true,
    value: jest.fn(() => "blob:mock"),
  })
})

function payload(over: Partial<SharePayload>): SharePayload {
  return { kind: "chat-text", mime: "text/plain", data: "", encoding: "utf8", ...over }
}

describe("PayloadView", () => {
  it("renders chat-html in a script-free sandboxed iframe", () => {
    render(<PayloadView payload={payload({ kind: "chat-html", data: "<p>hi</p>" })} />)
    const frame = screen.getByTitle("Shared conversation") as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.getAttribute("srcdoc")).toContain("<p>hi</p>")
  })

  it("allows scripts only for chat-animated", () => {
    render(<PayloadView payload={payload({ kind: "chat-animated", data: "<p>x</p>" })} />)
    const frame = screen.getByTitle("Shared conversation") as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
  })

  it("renders text formats as preformatted text", () => {
    render(<PayloadView payload={payload({ kind: "chat-md", data: "# title", title: "Doc" })} />)
    expect(screen.getByText("Doc")).toBeInTheDocument()
    expect(screen.getByText("# title")).toBeInTheDocument()
  })

  it("renders untitled text without a heading", () => {
    render(<PayloadView payload={payload({ kind: "chat-text", data: "plain body" })} />)
    expect(screen.getByText("plain body")).toBeInTheDocument()
    expect(screen.queryByRole("heading")).toBeNull()
  })

  it("renders workflow-png as a data-URL image", () => {
    render(
      <PayloadView
        payload={payload({
          kind: "workflow-png",
          mime: "image/png",
          data: "AAA",
          encoding: "base64",
        })}
      />
    )
    const img = screen.getByAltText("Shared workflow") as HTMLImageElement
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA")
  })

  it("renders a backup as a download card", () => {
    render(
      <PayloadView
        payload={payload({ kind: "backup", mime: "application/json", data: "{}", title: "Snap" })}
      />
    )
    expect(screen.getByText("Snap")).toBeInTheDocument()
    const link = screen.getByText("Download").closest("a") as HTMLAnchorElement
    expect(link.getAttribute("download")).toBe("snap.json")
  })

  it("decodes a base64 backup and falls back to a default filename", () => {
    render(
      <PayloadView
        payload={payload({ kind: "backup", mime: "", data: "e30=", encoding: "base64" })}
      />
    )
    // No title → fallback heading + filename slug; empty mime → json default.
    expect(screen.getByText("Shared backup")).toBeInTheDocument()
    const link = screen.getByText("Download").closest("a") as HTMLAnchorElement
    expect(link.getAttribute("download")).toBe("cognia-backup.json")
  })

  it("renders a workflow image with its title", () => {
    render(
      <PayloadView
        payload={payload({
          kind: "workflow-png",
          mime: "image/png",
          data: "AAA",
          encoding: "base64",
          title: "Pipeline",
        })}
      />
    )
    expect(screen.getByRole("heading", { name: "Pipeline" })).toBeInTheDocument()
    expect((screen.getByAltText("Pipeline") as HTMLImageElement).getAttribute("src")).toContain(
      "base64,AAA"
    )
  })

  it("shows the fallback when the a2ui JSON lacks an app", async () => {
    render(
      <PayloadView payload={payload({ kind: "a2ui", mime: "application/json", data: "{}" })} />
    )
    await waitFor(() =>
      expect(screen.getByText("This shared app could not be loaded.")).toBeInTheDocument()
    )
  })

  it("renders an a2ui app read-only", async () => {
    // Omit dataModel + surfaceType so the `?? {}` / `?? "inline"` defaults run.
    const appJson = JSON.stringify({
      version: "1.0",
      app: {
        title: "My App",
        components: [
          { id: "root", component: "Column", children: ["t1"] },
          { id: "t1", component: "Text", text: "Hello A2UI" },
        ],
      },
    })
    render(
      <PayloadView payload={payload({ kind: "a2ui", mime: "application/json", data: appJson })} />
    )
    expect(screen.getByText("Read-only preview")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("Hello A2UI")).toBeInTheDocument())
  })

  it("shows a fallback when the a2ui payload is malformed", async () => {
    render(
      <PayloadView
        payload={payload({ kind: "a2ui", mime: "application/json", data: "not json" })}
      />
    )
    await waitFor(() =>
      expect(screen.getByText("This shared app could not be loaded.")).toBeInTheDocument()
    )
  })
})
