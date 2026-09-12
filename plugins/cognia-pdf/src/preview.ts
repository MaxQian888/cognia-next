import type { ArtifactRenderer } from "@cognia/plugin-sdk"
import { base64ToBytes, parsePdfArtifact, PDF_MIME } from "./model"

interface PdfPreviewLabels {
  title: string
  unsupported: string
  error: string
  download: string
}

export function createPdfRenderer(labels: PdfPreviewLabels): ArtifactRenderer {
  return {
    name: "Cognia PDF",
    mount: (artifact, container) => {
      let objectUrl: string | undefined

      const renderError = (error: unknown) => {
        const box = window.document.createElement("div")
        box.setAttribute("role", "alert")
        box.style.cssText = "padding:16px;color:var(--destructive,#b91c1c);font-size:13px"
        box.textContent = `${labels.error} ${error instanceof Error ? error.message : String(error)}`
        container.replaceChildren(box)
      }

      const render = (content: string) => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
          objectUrl = undefined
        }
        let document_
        try {
          document_ = parsePdfArtifact(content)
        } catch (error) {
          renderError(error)
          return
        }
        const bytes = new Uint8Array(base64ToBytes(document_.dataBase64))
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: PDF_MIME }))

        const wrapper = window.document.createElement("div")
        wrapper.style.cssText = "display:flex;flex-direction:column;min-height:70vh"

        const bar = window.document.createElement("div")
        bar.style.cssText =
          "display:flex;justify-content:flex-end;padding:4px 8px;border-bottom:1px solid var(--border,#e5e7eb)"
        const link = window.document.createElement("a")
        link.href = objectUrl
        link.download = `${document_.title || "document"}.pdf`
        link.textContent = labels.download
        link.style.cssText = "font-size:12px;color:var(--primary,#2563eb);text-decoration:none"
        bar.appendChild(link)

        const frame = window.document.createElement("iframe")
        frame.title = `${labels.title}: ${document_.title}`
        frame.src = objectUrl
        frame.style.cssText = "width:100%;flex:1;min-height:65vh;border:0;background:white"
        frame.textContent = labels.unsupported

        wrapper.appendChild(bar)
        wrapper.appendChild(frame)
        container.replaceChildren(wrapper)
      }

      render(artifact.content)
      return {
        update: (updatedArtifact) => render(updatedArtifact.content),
        dispose: () => {
          if (objectUrl) URL.revokeObjectURL(objectUrl)
          container.replaceChildren()
        },
      }
    },
  }
}
