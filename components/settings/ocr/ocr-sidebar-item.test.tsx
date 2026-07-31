import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  OcrSidebarItem,
  OCR_ICON_MAP,
  ocrProviderInitial,
  type OcrProviderStatus,
} from "./ocr-sidebar-item"

const STATUSES: OcrProviderStatus[] = [
  "ready",
  "connected",
  "not-configured",
  "unsupported",
  "error",
]

describe("OcrSidebarItem", () => {
  it("renders each status variant with the right data-status attribute", () => {
    for (const status of STATUSES) {
      const { unmount } = render(
        <OcrSidebarItem
          providerId="mistral-ocr"
          name="Mistral OCR"
          subtitle="Document OCR"
          status={status}
          isSelected={false}
          onClick={() => {}}
          statusLabel={status}
        />
      )
      const btn = screen.getByRole("button")
      expect(btn.getAttribute("data-status")).toBe(status)
      unmount()
    }
  })

  it("fires onClick with the providerId", async () => {
    const user = userEvent.setup()
    const onClick = jest.fn()
    render(
      <OcrSidebarItem
        providerId="paddle-ocr"
        name="PaddleOCR"
        subtitle="Local"
        status="ready"
        isSelected={false}
        onClick={onClick}
        statusLabel="Ready"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(onClick).toHaveBeenCalledWith("paddle-ocr")
  })

  it("marks selected rows with the primary background", () => {
    render(
      <OcrSidebarItem
        providerId="ocrs"
        name="ocrs"
        subtitle="Local"
        status="ready"
        isSelected
        onClick={() => {}}
        statusLabel="Ready"
      />
    )
    expect(screen.getByRole("button").className).toMatch(/bg-primary/)
  })

  it("dims disabled rows when not selected", () => {
    render(
      <OcrSidebarItem
        providerId="ocrs"
        name="ocrs"
        subtitle="Local"
        status="ready"
        disabled
        isSelected={false}
        onClick={() => {}}
        statusLabel="Ready"
      />
    )
    const btn = screen.getByRole("button")
    expect(btn.className).toMatch(/opacity-60/)
    expect(btn.getAttribute("data-disabled")).toBe("true")
    expect(btn.getAttribute("aria-disabled")).toBe("true")
  })

  it("does not dim disabled rows when they are selected (keeps focus visible)", () => {
    render(
      <OcrSidebarItem
        providerId="ocrs"
        name="ocrs"
        subtitle="Local"
        status="ready"
        disabled
        isSelected
        onClick={() => {}}
        statusLabel="Ready"
      />
    )
    const btn = screen.getByRole("button")
    expect(btn.className).not.toMatch(/opacity-60/)
  })

  it("renders a brand icon for a supported OCR provider", () => {
    render(
      <OcrSidebarItem
        providerId="mistral-ocr"
        name="Mistral OCR"
        subtitle="Cloud"
        status="connected"
        isSelected={false}
        onClick={() => {}}
        statusLabel="Connected"
      />
    )
    expect(document.querySelector('img[src="/icons/lobe/mistral-color.svg"]')).not.toBeNull()
  })

  it("keeps the initial fallback for an OCR provider without a brand asset", () => {
    render(
      <OcrSidebarItem
        providerId="paddle-ocr"
        name="PaddleOCR"
        subtitle="Local"
        status="ready"
        isSelected={false}
        onClick={() => {}}
        statusLabel="Ready"
      />
    )

    expect(screen.getByRole("button")).toHaveTextContent("P")
  })

  it("accepts an icon override", () => {
    render(
      <OcrSidebarItem
        providerId="custom"
        name="Custom"
        subtitle="x"
        status="ready"
        isSelected={false}
        onClick={() => {}}
        icon={<span data-testid="custom-icon">★</span>}
        statusLabel="Ready"
      />
    )
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument()
  })
})

describe("ocrProviderInitial", () => {
  it("matches every known provider in the icon map", () => {
    const known = [
      "mistral-ocr",
      "google-vision",
      "aws-textract",
      "azure-document-intelligence",
      "anthropic-vision",
      "openai-vision",
      "gemini-vision",
      "mathpix",
      "ocr-space",
      "abbyy-cloud",
      "nanonets",
      "lark-basic",
      "tesseract-wasm",
      "tesseract-native",
      "windows-media-ocr",
      "apple-vision",
      "mlkit-android",
      "ocrs",
      "paddle-ocr",
      "local-http",
    ]
    for (const id of known) {
      expect(ocrProviderInitial(id)).toMatch(/^[A-Z]$/)
    }
  })

  it("falls back to the first character for unknown providers", () => {
    expect(ocrProviderInitial("zzz-experimental")).toBe("Z")
  })

  it("exposes the icon map for downstream tooling", () => {
    expect(OCR_ICON_MAP.length).toBeGreaterThan(0)
  })
})
