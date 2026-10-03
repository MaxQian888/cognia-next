import { pickOpenUris, pickSaveUri, type NativeDialogs } from "./native-dialogs"

jest.mock("@/lib/platform/detect", () => ({ isTauri: () => false }))

function dialogs(answer: string | string[] | null) {
  const native: NativeDialogs & { open: jest.Mock; save: jest.Mock } = {
    open: jest.fn(async () => answer),
    save: jest.fn(async () => (Array.isArray(answer) ? answer[0] : answer)),
  }
  return native
}

describe("native dialogs", () => {
  it("opens files by default, with VS Code filters and the default location", async () => {
    const native = dialogs(["/a/b.ts", "/a/c d.ts"])
    await expect(
      pickOpenUris(
        {
          canSelectMany: true,
          defaultUri: "file:///a",
          filters: { TypeScript: ["ts", "tsx"] },
          openLabel: "Import",
        },
        native
      )
    ).resolves.toEqual(["file:///a/b.ts", "file:///a/c%20d.ts"])
    expect(native.open).toHaveBeenCalledWith({
      directory: false,
      multiple: true,
      defaultPath: "/a",
      filters: [{ name: "TypeScript", extensions: ["ts", "tsx"] }],
      title: "Import",
    })
  })

  it("opens folders only when files are excluded, and reports a cancel as null", async () => {
    const native = dialogs(null)
    await expect(
      pickOpenUris({ canSelectFolders: true, canSelectFiles: false, filters: { X: ["x"] } }, native)
    ).resolves.toBeNull()
    expect(native.open).toHaveBeenCalledWith({ directory: true, multiple: false })
  })

  it("saves to a file URI", async () => {
    const native = dialogs("/tmp/out.json")
    await expect(pickSaveUri({ saveLabel: "Export" }, native)).resolves.toBe("file:///tmp/out.json")
    expect(native.save).toHaveBeenCalledWith({ title: "Export" })
  })

  it("outside the desktop app the call fails instead of looking cancelled", async () => {
    await expect(pickOpenUris({})).rejects.toThrow(/desktop app/)
    await expect(pickSaveUri({})).rejects.toThrow(/desktop app/)
  })
})
