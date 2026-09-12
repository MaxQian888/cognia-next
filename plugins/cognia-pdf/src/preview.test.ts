/** @jest-environment jsdom */

import type { Artifact } from "@cognia/plugin-sdk"
import { createPdfArtifactDocument, PDF_ARTIFACT_KIND } from "./model"
import { createPdfRenderer } from "./preview"

const createObjectURL = jest.fn(() => "blob:pdf")
const revokeObjectURL = jest.fn()

Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL })

const LABELS = {
  title: "PDF preview",
  unsupported: "Unsupported",
  error: "Unable to render.",
  download: "Download PDF",
}

function artifact(content?: string): Artifact {
  return {
    id: "pdf-1",
    sessionId: "",
    messageId: "",
    type: "code",
    title: "Form",
    content:
      content ??
      JSON.stringify(
        createPdfArtifactDocument({
          title: "Form",
          bytes: Uint8Array.from([1, 2, 3]),
          inspection: {
            pageCount: 1,
            encrypted: false,
            signed: false,
            fields: [],
            metadata: {},
            warnings: [],
          },
        })
      ),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {
      plugin: { kind: PDF_ARTIFACT_KIND, schemaVersion: 1, ownerPluginId: "cognia-pdf" },
    },
  }
}

beforeEach(() => {
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
})

it("renders a PDF blob with a download link and revokes object URLs", () => {
  const container = document.createElement("div")
  const mounted = createPdfRenderer(LABELS).mount(artifact(), container)

  expect(container.querySelector("iframe")).toHaveAttribute("src", "blob:pdf")
  const link = container.querySelector("a")!
  expect(link).toHaveAttribute("href", "blob:pdf")
  expect(link).toHaveAttribute("download", "Form.pdf")
  expect(link).toHaveTextContent("Download PDF")

  mounted?.update?.(artifact())
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf")
  mounted?.dispose?.()
  expect(container).toBeEmptyDOMElement()
})

it("shows an error surface for a malformed artifact and revokes nothing on dispose", () => {
  const container = document.createElement("div")
  const mounted = createPdfRenderer(LABELS).mount(artifact("not json"), container)

  expect(container.querySelector("iframe")).toBeNull()
  const alert = container.querySelector('[role="alert"]')!
  expect(alert).toHaveTextContent("Unable to render.")
  expect(createObjectURL).not.toHaveBeenCalled()

  // Recovering on update: valid content replaces the error surface.
  mounted?.update?.(artifact())
  expect(container.querySelector("iframe")).toHaveAttribute("src", "blob:pdf")
  mounted?.dispose?.()
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf")
})
