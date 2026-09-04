/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

interface Opener {
  root: string
  open: (path: string, line?: number, column?: number) => void
  applyEdit?: (path: string, line?: number, column?: number) => void
  readActive?: () => Promise<unknown>
  saveDirty?: () => Promise<string[]>
  showDiff?: (path: string, content: string, title?: string) => Promise<void>
  reveal?: (path: string) => Promise<void>
  runInTerminal?: (command: string, options?: { cwd?: string; name?: string }) => Promise<void>
  notify?: (message: string, kind?: "info" | "warning" | "error") => Promise<void>
}

let registered: Opener | undefined
const unregister = jest.fn()
const readActive = jest.fn()
const saveAll = jest.fn()
const reveal = jest.fn()
const runInTerminal = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/lib/files/project-editor-bridge", () => ({
  registerProjectEditorOpener: (opener: Opener) => {
    registered = opener
    return unregister
  },
}))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    driveOpen: jest.fn(async () => undefined),
    driveApplyEdit: jest.fn(async () => undefined),
    openFile: jest.fn(async () => undefined),
    readActive: (...args: unknown[]) => readActive(...args),
    saveAll: (...args: unknown[]) => saveAll(...args),
    showDiff: jest.fn(async () => undefined),
    reveal: (...args: unknown[]) => reveal(...args),
    runInTerminal: (...args: unknown[]) => runInTerminal(...args),
    notify: jest.fn(async () => undefined),
  },
}))

import { joinProjectPath, useCodeServerProjectOpener } from "./use-code-server-project-opener"

function Harness({ enabled, root = "/repo" }: { enabled: boolean; root?: string }) {
  useCodeServerProjectOpener({ root, enabled })
  return null
}

beforeEach(() => {
  jest.clearAllMocks()
  registered = undefined
  saveAll.mockResolvedValue({ saved: [], failed: [] })
})

describe("joinProjectPath", () => {
  it("joins a root and a relative path", () => {
    expect(joinProjectPath("/repo", "src/index.ts")).toBe("/repo/src/index.ts")
  })

  it("tolerates a trailing root slash and a leading path slash", () => {
    expect(joinProjectPath("/repo/", "/src/index.ts")).toBe("/repo/src/index.ts")
  })

  it("resolves an empty path to the root itself", () => {
    expect(joinProjectPath("/repo/", "")).toBe("/repo")
  })
})

describe("useCodeServerProjectOpener", () => {
  it("registers nothing until the workbench can answer", () => {
    render(<Harness enabled={false} />)
    expect(registered).toBeUndefined()
  })

  it("registers for the root once enabled", () => {
    render(<Harness enabled />)
    expect(registered?.root).toBe("/repo")
  })

  it("unregisters when the workbench goes away", () => {
    const { rerender } = render(<Harness enabled />)
    expect(registered).toBeDefined()
    rerender(<Harness enabled={false} />)
    expect(unregister).toHaveBeenCalled()
  })

  it("re-registers against a new root", () => {
    const { rerender } = render(<Harness enabled />)
    rerender(<Harness enabled root="/other" />)
    expect(unregister).toHaveBeenCalled()
    expect(registered?.root).toBe("/other")
  })

  it("reports back only the buffers it could not save", async () => {
    // The bridge's contract is "which paths are still dirty", not the whole
    // result, so an agent turn can refuse to read a file it would misread.
    saveAll.mockResolvedValue({ saved: ["/repo/a.ts"], failed: ["/repo/b.ts"] })
    render(<Harness enabled />)
    await expect(registered?.saveDirty?.()).resolves.toEqual(["/repo/b.ts"])
  })

  it("addresses reveal by absolute path and runs terminals in the root by default", async () => {
    render(<Harness enabled />)
    await registered?.reveal?.("src/a.ts")
    expect(reveal).toHaveBeenCalledWith("/repo", "/repo/src/a.ts")

    await registered?.runInTerminal?.("pnpm test")
    expect(runInTerminal).toHaveBeenCalledWith("/repo", "pnpm test", { cwd: "/repo" })
  })

  it("reads the active editor from the root it registered for", async () => {
    render(<Harness enabled />)
    await registered?.readActive?.()
    expect(readActive).toHaveBeenCalledWith("/repo")
  })
})
