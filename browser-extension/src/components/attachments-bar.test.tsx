/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import type { PendingAttachment } from "@ext/src/lib/panel/screenshots"

import { AttachmentsBar } from "./attachments-bar"

const api = {
  message: (key: string, subs?: string[]) => (subs ? `${key}:${subs.join("/")}` : key),
} as unknown as BrowserApi

const SHOT: PendingAttachment = {
  id: "a1",
  name: "shot.png",
  mediaType: "image/png",
  kind: "screenshot",
  bytes: new Uint8Array(2048),
  previewUrl: "data:image/png;base64,AA==",
}
const PDF: PendingAttachment = {
  id: "a2",
  name: "doc.pdf",
  mediaType: "application/pdf",
  kind: "pdf",
  bytes: new Uint8Array(10),
}

function setup(overrides: Partial<Parameters<typeof AttachmentsBar>[0]> = {}) {
  const props = {
    api,
    attachments: [SHOT, PDF],
    max: 6,
    canAttachPdf: false,
    busy: null,
    progress: {},
    onAttach: jest.fn(),
    onRemove: jest.fn(),
    ...overrides,
  }
  render(<AttachmentsBar {...props} />)
  return props
}

describe("AttachmentsBar", () => {
  it("offers each capture, the PDF only when the tab shows one", () => {
    const props = setup()
    expect(screen.queryByTestId("attach-pdf")).toBeNull()
    fireEvent.click(screen.getByTestId("attach-region"))
    expect(props.onAttach).toHaveBeenCalledWith("region")
  })

  it("shows thumbnails and sizes, and removes", () => {
    const props = setup({ canAttachPdf: true })
    expect(screen.getByTestId("attach-pdf")).toBeInTheDocument()
    expect(screen.getByTestId("attachment-a1")).toHaveTextContent("captureBytes:2.0")
    expect(screen.getByTestId("attachment-a2")).toHaveTextContent("PDF")
    fireEvent.click(screen.getByTestId("attachment-remove-a2"))
    expect(props.onRemove).toHaveBeenCalledWith("a2")
  })

  it("stops offering more at the limit or while busy, and shows upload progress", () => {
    setup({ max: 2, progress: { a1: 0.5 } })
    expect(screen.getByTestId("attach-visible")).toBeDisabled()
    expect(screen.getByText("attachFull")).toBeInTheDocument()
    expect(screen.queryByTestId("attachment-remove-a1")).toBeNull()
  })

  it("labels the action under way", () => {
    setup({ attachments: [], busy: "full-page" })
    expect(screen.getByTestId("attach-full-page")).toHaveTextContent("attachWorking")
    expect(screen.getByTestId("attach-visible")).toBeDisabled()
  })
})
