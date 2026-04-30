jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: { getState: jest.fn() },
}))

import { createEditorOptions } from "./index"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"

const mockedGetState = useCanvasSettingsStore.getState as unknown as jest.Mock

beforeEach(() => {
  mockedGetState.mockReset()
})

describe("createEditorOptions", () => {
  it("merges base options with code defaults (wrap unchanged)", () => {
    mockedGetState.mockReturnValue({
      getEditorOptions: () => ({ fontSize: 14, wordWrap: "off" }),
    })
    const opts = createEditorOptions("code")
    expect(opts.fontSize).toBe(14)
    expect(opts.wordWrap).toBe("off")
    expect(opts.automaticLayout).toBe(true)
  })

  it("forces wordWrap to 'on' for documents", () => {
    mockedGetState.mockReturnValue({
      getEditorOptions: () => ({ fontSize: 16, wordWrap: "off" }),
    })
    const opts = createEditorOptions("document")
    expect(opts.wordWrap).toBe("on")
  })

  it("applies caller-supplied overrides last", () => {
    mockedGetState.mockReturnValue({
      getEditorOptions: () => ({ wordWrap: "on", fontSize: 12 }),
    })
    const opts = createEditorOptions("code", { fontSize: 22, readOnly: true })
    expect(opts.fontSize).toBe(22)
    expect(opts.readOnly).toBe(true)
    expect(opts.automaticLayout).toBe(true)
  })
})
