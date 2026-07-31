/** @jest-environment jsdom */
import { renderChatToPng, pngBackground, ChatPngTooLongError, MAX_PNG_HEIGHT_PX } from "./chat-png"
import { THEMES } from "./syntax-themes"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

const mockHtml2canvas = jest.fn()
jest.mock("html2canvas-pro", () => ({
  __esModule: true,
  default: (...a: unknown[]) => mockHtml2canvas(...a),
}))

const session: ChatSession = {
  id: "s1",
  title: "PNG me",
  kind: "direct",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}
const messages: StoredMessage[] = [
  { id: "m1", sessionId: "s1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 1 },
]

// Override iframe srcdoc/contentDocument so the flow is deterministic in jsdom.
let capturedHeight = 800
let iframeMode: "load" | "error" | "no-doc" = "load"
function stubIframes() {
  const realCreate = document.createElement.bind(document)
  jest.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = realCreate(tag) as HTMLElement
    if (tag === "iframe") {
      Object.defineProperty(el, "srcdoc", {
        configurable: true,
        set() {
          setTimeout(
            () => el.dispatchEvent(new Event(iframeMode === "error" ? "error" : "load")),
            0
          )
        },
      })
      Object.defineProperty(el, "contentDocument", {
        configurable: true,
        get: () =>
          iframeMode === "no-doc"
            ? null
            : {
                body: { scrollHeight: capturedHeight },
                documentElement: { scrollHeight: capturedHeight },
              },
      })
    }
    return el
  }) as typeof document.createElement)
}

beforeEach(() => {
  jest.clearAllMocks()
  capturedHeight = 800
  iframeMode = "load"
  stubIframes()
})
afterEach(() => {
  ;(document.createElement as jest.Mock).mockRestore?.()
})

function fakeCanvas(blob: Blob | null = new Blob(["png"], { type: "image/png" })) {
  return { toBlob: (cb: (b: Blob | null) => void) => cb(blob) }
}

describe("pngBackground", () => {
  it("uses the theme bg by default and the custom theme override when present", () => {
    expect(pngBackground({ session, messages, exportedAt: new Date(), theme: "dracula" })).toBe(
      THEMES.dracula.bg
    )
    expect(
      pngBackground({
        session,
        messages,
        exportedAt: new Date(),
        customTheme: { ...THEMES.light, bg: "#abcdef" },
      })
    ).toBe("#abcdef")
  })
})

describe("renderChatToPng", () => {
  it("rasterizes to a PNG blob and cleans up the off-screen iframe", async () => {
    mockHtml2canvas.mockResolvedValue(fakeCanvas())
    const before = document.querySelectorAll("iframe").length
    const blob = await renderChatToPng({
      session,
      messages,
      exportedAt: new Date(),
      theme: "arknights",
    })
    expect(blob).toBeInstanceOf(Blob)
    expect(mockHtml2canvas).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll("iframe").length).toBe(before)
  })

  it("throws ChatPngTooLongError when the render exceeds the height cap", async () => {
    capturedHeight = MAX_PNG_HEIGHT_PX + 1
    await expect(
      renderChatToPng({ session, messages, exportedAt: new Date(), theme: "light" })
    ).rejects.toBeInstanceOf(ChatPngTooLongError)
    // Still cleaned up.
    expect(document.querySelectorAll("iframe").length).toBe(0)
    expect(mockHtml2canvas).not.toHaveBeenCalled()
  })

  it("rejects when toBlob yields null", async () => {
    mockHtml2canvas.mockResolvedValue(fakeCanvas(null))
    await expect(
      renderChatToPng({ session, messages, exportedAt: new Date(), theme: "light" })
    ).rejects.toThrow("toBlob failed")
  })

  it("rejects when the iframe fails to load", async () => {
    iframeMode = "error"
    await expect(
      renderChatToPng({ session, messages, exportedAt: new Date(), theme: "light" })
    ).rejects.toThrow("iframe load failed")
    expect(document.querySelectorAll("iframe").length).toBe(0)
  })

  it("rejects when the capture document is unavailable", async () => {
    iframeMode = "no-doc"
    await expect(
      renderChatToPng({ session, messages, exportedAt: new Date(), theme: "light" })
    ).rejects.toThrow("capture document unavailable")
    expect(document.querySelectorAll("iframe").length).toBe(0)
  })
})
