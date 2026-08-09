/** @jest-environment jsdom */

import type { Artifact } from "@/types/artifact"
import { createPdfArtifactDocument, PDF_ARTIFACT_KIND } from "./model"
import { createPdfRenderer } from "./preview"

const createObjectURL = jest.fn(() => "blob:pdf")
const revokeObjectURL = jest.fn()

Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL })

function artifact(): Artifact {
  return {
    id: "pdf-1",
    sessionId: "",
    messageId: "",
    type: "code",
    title: "Form",
    content: JSON.stringify(
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

it("renders a PDF blob and revokes object URLs on update and dispose", () => {
  const container = document.createElement("div")
  const mounted = createPdfRenderer({ title: "PDF preview", unsupported: "Unsupported" }).mount(
    artifact(),
    container
  )
  expect(container.querySelector("iframe")).toHaveAttribute("src", "blob:pdf")
  mounted?.update?.(artifact())
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf")
  mounted?.dispose?.()
  expect(container).toBeEmptyDOMElement()
})
