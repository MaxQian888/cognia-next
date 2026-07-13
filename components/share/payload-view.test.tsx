import React from "react"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { PayloadView } from "./payload-view"
import type { SharePayload } from "@/lib/share/types"

// jsdom doesn't implement object URLs; the backup card + image download need them.
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    writable: true,
    value: jest.fn(() => "blob:mock"),
  })
  Object.defineProperty(URL, "revokeObjectURL", { writable: true, value: jest.fn() })
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

  it("renders usage-card in the same script-free sandbox as chat-html", () => {
    render(
      <PayloadView payload={payload({ kind: "usage-card", data: '<div class="ucard"></div>' })} />
    )
    const frame = screen.getByTitle("Shared conversation") as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.getAttribute("srcdoc")).toContain("ucard")
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

  it("renders chat-quote in the same script-free sandbox", () => {
    render(
      <PayloadView payload={payload({ kind: "chat-quote", data: '<div class="qcard"></div>' })} />
    )
    const frame = screen.getByTitle("Shared conversation") as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.getAttribute("srcdoc")).toContain("qcard")
  })

  it("offers download and copy actions for shared images", () => {
    render(
      <PayloadView
        payload={payload({
          kind: "workflow-png",
          mime: "image/png",
          data: "AAA",
          encoding: "base64",
          title: "My Flow",
        })}
      />
    )
    fireEvent.click(screen.getByText("Download image"))
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(screen.getByText("Copy image")).toBeInTheDocument()
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

  it("renders a shared character definition read-only", () => {
    const data = JSON.stringify({
      kind: "character",
      name: "Researcher",
      description: "Finds things",
      systemPrompt: "Be careful.",
      model: "claude-opus-4-8",
    })
    render(<PayloadView payload={payload({ kind: "discover-item", data })} />)
    expect(screen.getByText("Character")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Researcher" })).toBeInTheDocument()
    expect(screen.getByText("System prompt")).toBeInTheDocument()
    expect(screen.getByText("Be careful.")).toBeInTheDocument()
  })

  it("renders a shared team with the descriptive-roster note", () => {
    const data = JSON.stringify({
      kind: "team",
      name: "Squad",
      orchestration: "supervisor",
      members: [{ role: "Lead", systemPromptOverride: "Coordinate." }, {}],
    })
    render(<PayloadView payload={payload({ kind: "discover-item", data })} />)
    expect(screen.getByText("Team")).toBeInTheDocument()
    expect(screen.getByText("Coordinate.")).toBeInTheDocument()
    expect(
      screen.getByText("This is a descriptive snapshot — member links are not importable.")
    ).toBeInTheDocument()
  })

  it("renders a shared workflow template with required slot + note", () => {
    const data = JSON.stringify({
      kind: "workflowTemplate",
      name: "Cron report",
      tags: ["cron"],
      slots: [{ key: "channel", type: "string", label: "Channel", required: true }],
    })
    render(<PayloadView payload={payload({ kind: "discover-item", data })} />)
    expect(screen.getByText("Workflow template")).toBeInTheDocument()
    expect(screen.getByText("Channel")).toBeInTheDocument()
    expect(screen.getByText("Required")).toBeInTheDocument()
  })

  it("shows the fallback when the discover-item JSON is malformed", () => {
    render(<PayloadView payload={payload({ kind: "discover-item", data: "not json" })} />)
    expect(screen.getByText("This shared item could not be loaded.")).toBeInTheDocument()
  })
})
