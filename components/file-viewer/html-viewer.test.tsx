import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import HtmlViewer from "./html-viewer"
import type { FileViewerRenderProps, FileViewerSource } from "@/lib/file-viewer/types"

const messages = { fileViewer: { frameTitle: "File preview" } }

function renderViewer(source: FileViewerSource, text: string) {
  const props: FileViewerRenderProps = {
    text,
    displayName: "page.html",
    relPath: "page.html",
    line: null,
    column: null,
    source,
  }
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HtmlViewer {...props} />
    </NextIntlClientProvider>
  )
  return screen.getByTestId("project-html-preview") as HTMLIFrameElement
}

describe("HtmlViewer", () => {
  // Without `allow-same-origin` the frame runs in an opaque origin and cannot
  // reach the host document at all. This is the assertion that must never be
  // relaxed to make a preview "work".
  it.each(["project-preview", "terminal"] as const)(
    "never grants same-origin access to a %s preview",
    (source) => {
      const frame = renderViewer(source, "<p>hi</p>")
      expect(frame.getAttribute("sandbox") ?? "").not.toContain("allow-same-origin")
    }
  )

  // The hole the old project preview left open: `allow-scripts` with no CSP let
  // a previewed file fetch its own contents to any origin. An opaque origin
  // stops a frame reading the host, not talking to the network.
  it.each(["project-preview", "terminal"] as const)(
    "blocks outbound network requests from a %s preview",
    (source) => {
      const frame = renderViewer(source, "<p>hi</p>")
      expect(frame.srcdoc).toContain("connect-src 'none'")
      expect(frame.srcdoc).toContain("default-src 'none'")
    }
  )

  it("lets the user's own draft run scripts, but drops forms, modals and popups", () => {
    const frame = renderViewer("project-preview", "<script>1</script>")
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame.srcdoc).toContain("script-src 'unsafe-inline'")
    // Popups let a preview spawn windows and modals let it alert()-loop the
    // app; neither is needed to look at a page.
    for (const dropped of ["allow-forms", "allow-modals", "allow-popups"]) {
      expect(frame.getAttribute("sandbox")).not.toContain(dropped)
    }
  })

  it("disables and strips scripts for a terminal link", () => {
    // Terminal-linked HTML is far more likely to be tool-generated or
    // downloaded than authored by the person looking at it.
    const frame = renderViewer("terminal", "<p>kept</p><script>evil()</script>")
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.srcdoc).not.toContain("script-src")
    expect(frame.srcdoc).toContain("kept")
    expect(frame.srcdoc).not.toContain("evil()")
  })
})
