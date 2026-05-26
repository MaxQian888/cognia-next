import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { PayloadView } from "./PayloadView"
import type { SharePayload } from "@/lib/share/types"

function payload(p: Partial<SharePayload>): SharePayload {
  return { kind: "chat-text", mime: "text/plain", data: "x", encoding: "utf8", ...p }
}

describe("PayloadView", () => {
  it("renders chat-html into a sandboxed iframe with no scripts", () => {
    render(
      <PayloadView
        payload={payload({ kind: "chat-html", mime: "text/html", data: "<b>hi</b>", title: "Doc" })}
      />
    )
    const frame = screen.getByTitle("Doc") as HTMLIFrameElement
    expect(frame.tagName).toBe("IFRAME")
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.getAttribute("srcdoc")).toContain("<b>hi</b>")
  })

  it("allows scripts for animated html", () => {
    render(
      <PayloadView
        payload={payload({
          kind: "chat-animated",
          mime: "text/html",
          data: "<b>x</b>",
          title: "Anim",
        })}
      />
    )
    expect((screen.getByTitle("Anim") as HTMLIFrameElement).getAttribute("sandbox")).toBe(
      "allow-scripts"
    )
  })

  it("renders text formats as preformatted text", () => {
    render(<PayloadView payload={payload({ kind: "chat-md", data: "# heading", title: "MD" })} />)
    expect(screen.getByText("# heading").tagName).toBe("PRE")
  })

  it("renders a png as a data url image", () => {
    render(
      <PayloadView
        payload={payload({
          kind: "workflow-png",
          mime: "image/png",
          data: "AAA",
          encoding: "base64",
          title: "Flow",
        })}
      />
    )
    expect((screen.getByAltText("Flow") as HTMLImageElement).getAttribute("src")).toBe(
      "data:image/png;base64,AAA"
    )
  })

  it("offers a backup download", () => {
    render(
      <PayloadView
        payload={payload({ kind: "backup", mime: "application/json", data: "{}", title: "Backup" })}
      />
    )
    const link = screen.getByText("Download") as HTMLAnchorElement
    expect(link.getAttribute("download")).toBe("backup.json")
  })

  it("offers an a2ui app download", () => {
    render(
      <PayloadView
        payload={payload({ kind: "a2ui", mime: "application/json", data: "{}", title: "App" })}
      />
    )
    expect(screen.getByText("App")).toBeInTheDocument()
    expect((screen.getByText("Download") as HTMLAnchorElement).getAttribute("download")).toBe(
      "app.json"
    )
  })
})
