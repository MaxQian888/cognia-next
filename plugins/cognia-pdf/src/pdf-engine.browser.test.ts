/** @jest-environment jsdom */
const workerOptions = { workerSrc: "" }
jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: workerOptions,
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 0,
      getMetadata: async () => ({ info: {} }),
      getSignatures: async () => [],
      hasJSActions: async () => false,
      loadingTask: { destroy: async () => undefined },
    }),
  }),
}))
import { disposePdfWorker, inspectPdf } from "./pdf-engine"

test("embedded worker bytes use a reusable CSP-compatible blob URL and release it on disposal", async () => {
  const scope = globalThis as { __COGNIA_PDF_WORKER_URL__?: string }
  const previousWorker = scope.__COGNIA_PDF_WORKER_URL__
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = jest.fn(() => "blob:https://cognia.local/worker")
  URL.revokeObjectURL = jest.fn()
  scope.__COGNIA_PDF_WORKER_URL__ = "data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHg9MQ=="
  try {
    await inspectPdf(Uint8Array.from([1]))
    await inspectPdf(Uint8Array.from([1]))
    expect(workerOptions.workerSrc).toBe("blob:https://cognia.local/worker")
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    disposePdfWorker()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://cognia.local/worker")
  } finally {
    disposePdfWorker()
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
    if (previousWorker === undefined) delete scope.__COGNIA_PDF_WORKER_URL__
    else scope.__COGNIA_PDF_WORKER_URL__ = previousWorker
  }
})
