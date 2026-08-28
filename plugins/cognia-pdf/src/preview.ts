import type { ArtifactRenderer } from "@cognia/plugin-sdk"
import { base64ToBytes, parsePdfArtifact, PDF_MIME } from "./model"

interface PdfPreviewLabels {
  title: string
  unsupported: string
}

export function createPdfRenderer(labels: PdfPreviewLabels): ArtifactRenderer {
  return {
    name: "Cognia PDF",
    mount: (artifact, container) => {
      let objectUrl: string | undefined

      const render = (content: string) => {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        const document = parsePdfArtifact(content)
        const bytes = new Uint8Array(base64ToBytes(document.dataBase64))
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: PDF_MIME }))
        const frame = window.document.createElement("iframe")
        frame.title = `${labels.title}: ${document.title}`
        frame.src = objectUrl
        frame.style.cssText = "width:100%;min-height:70vh;border:0;background:white"
        frame.textContent = labels.unsupported
        container.replaceChildren(frame)
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
