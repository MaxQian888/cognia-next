/** @jest-environment jsdom */
import { render } from "@testing-library/react"

import { isTauri } from "@/lib/tauri"
import { ensureEditorLspRuntime } from "@/lib/lsp/ensure-editor-lsp-runtime"
import { EditorLspRuntimeInitializer } from "./editor-lsp-runtime-initializer"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/lsp/ensure-editor-lsp-runtime", () => ({
  ensureEditorLspRuntime: jest.fn(),
}))

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockEnsure = ensureEditorLspRuntime as jest.MockedFunction<typeof ensureEditorLspRuntime>

describe("EditorLspRuntimeInitializer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("ensures the runtime once on the desktop host", () => {
    mockIsTauri.mockReturnValue(true)
    render(<EditorLspRuntimeInitializer />)
    expect(mockEnsure).toHaveBeenCalledTimes(1)
  })

  it("does nothing off the desktop host", () => {
    mockIsTauri.mockReturnValue(false)
    render(<EditorLspRuntimeInitializer />)
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it("does not re-trigger across a rerender", () => {
    mockIsTauri.mockReturnValue(true)
    const { rerender } = render(<EditorLspRuntimeInitializer />)
    rerender(<EditorLspRuntimeInitializer />)
    expect(mockEnsure).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    mockIsTauri.mockReturnValue(true)
    const { container } = render(<EditorLspRuntimeInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
