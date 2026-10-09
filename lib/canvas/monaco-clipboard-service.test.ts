/**
 * @jest-environment jsdom
 */
import { CogniaMonacoClipboardService } from "./monaco-clipboard-service"

function makeHelpers(clipboard = { text: "" }) {
  const helpers = {
    readClipboardText: jest.fn(async () => clipboard.text as string | null),
    writeClipboardText: jest.fn(async (text: string) => {
      clipboard.text = text
    }),
  }
  return { helpers, clipboard, load: jest.fn(async () => helpers) }
}

describe("CogniaMonacoClipboardService", () => {
  it("declines a native paste trigger so Monaco's paste falls through to readText", () => {
    const { load } = makeHelpers()
    expect(new CogniaMonacoClipboardService(load).triggerPaste()).toBeUndefined()
  })

  it("routes untyped text through the platform clipboard helpers", async () => {
    const { load, clipboard, helpers } = makeHelpers({ text: "from os" })
    const service = new CogniaMonacoClipboardService(load)

    await expect(service.readText()).resolves.toBe("from os")
    await service.writeText("copied")
    expect(helpers.writeClipboardText).toHaveBeenCalledWith("copied")
    expect(clipboard.text).toBe("copied")
  })

  it("keeps typed text in memory without touching the system clipboard", async () => {
    const { load, helpers } = makeHelpers()
    const service = new CogniaMonacoClipboardService(load)

    await service.writeText("selection", "text/vscode-selection")
    await expect(service.readText("text/vscode-selection")).resolves.toBe("selection")
    await expect(service.readText("other")).resolves.toBe("")
    expect(helpers.writeClipboardText).not.toHaveBeenCalled()
  })

  it("reads an unreadable clipboard as empty instead of throwing", async () => {
    const { load, helpers } = makeHelpers()
    helpers.readClipboardText.mockResolvedValueOnce(null)
    const service = new CogniaMonacoClipboardService(load)
    await expect(service.readText()).resolves.toBe("")

    helpers.readClipboardText.mockRejectedValueOnce(new Error("denied"))
    await expect(service.readText()).resolves.toBe("")
  })

  it("falls back to execCommand('copy') when every backend refuses the write", async () => {
    const { load, helpers } = makeHelpers()
    helpers.writeClipboardText.mockRejectedValueOnce(new Error("NotAllowedError"))
    const execCommand = jest.fn(() => true)
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true })
    const focused = document.createElement("input")
    document.body.appendChild(focused)
    focused.focus()

    await new CogniaMonacoClipboardService(load).writeText("rescued")

    expect(execCommand).toHaveBeenCalledWith("copy")
    // The hidden textarea is gone and focus is handed back.
    expect(document.querySelector("textarea")).toBeNull()
    expect(document.activeElement).toBe(focused)
    focused.remove()
  })

  it("keeps the find buffer in memory", async () => {
    const service = new CogniaMonacoClipboardService(makeHelpers().load)
    await service.writeFindText("needle")
    await expect(service.readFindText()).resolves.toBe("needle")
  })

  it("drops stored resources once the clipboard text they were written against changes", async () => {
    const { load, clipboard } = makeHelpers({ text: "paths" })
    const service = new CogniaMonacoClipboardService(load)
    const resource = { path: "/repo/a.ts" }

    await service.writeResources([resource])
    await expect(service.readResources()).resolves.toEqual([resource])
    await expect(service.hasResources()).resolves.toBe(true)

    clipboard.text = "something else"
    await expect(service.readResources()).resolves.toEqual([])
    await expect(service.hasResources()).resolves.toBe(false)
  })

  it("a text write invalidates resources, as does clearInternalState", async () => {
    const service = new CogniaMonacoClipboardService(makeHelpers({ text: "x" }).load)
    await service.writeResources([{ path: "a" }])
    await service.writeText("y")
    await expect(service.readResources()).resolves.toEqual([])

    await service.writeResources([{ path: "b" }])
    service.clearInternalState()
    await expect(service.readResources()).resolves.toEqual([])
  })

  it("reports no clipboard image", async () => {
    const service = new CogniaMonacoClipboardService(makeHelpers().load)
    await expect(service.readImage()).resolves.toEqual(new Uint8Array(0))
  })

  it("loads the platform helpers lazily, not at construction", () => {
    const { load } = makeHelpers()
    new CogniaMonacoClipboardService(load)
    expect(load).not.toHaveBeenCalled()
  })
})
