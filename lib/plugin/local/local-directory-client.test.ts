import { createLocalDirectoryClient } from "./local-directory-client"

jest.mock("./install-from-directory", () => ({
  previewLocalManifest: jest.fn(),
  installPluginFromDirectory: jest.fn(),
}))

import { previewLocalManifest, installPluginFromDirectory } from "./install-from-directory"

const mockPreview = previewLocalManifest as jest.MockedFunction<typeof previewLocalManifest>
const mockInstall = installPluginFromDirectory as jest.MockedFunction<
  typeof installPluginFromDirectory
>

beforeEach(() => {
  mockPreview.mockReset()
  mockInstall.mockReset()
})

describe("createLocalDirectoryClient", () => {
  it("getPlugin reads the manifest via previewLocalManifest", async () => {
    mockPreview.mockResolvedValueOnce({
      id: "demo",
      name: "Demo Plugin",
      version: "1.0.0",
      type: "frontend",
    } as never)
    const client = createLocalDirectoryClient("C:/plugins/demo")
    const result = await client.getPlugin("anything")
    expect(result).toMatchObject({
      manifest: { id: "demo", name: "Demo Plugin" },
      name: "Demo Plugin",
    })
    expect(mockPreview).toHaveBeenCalledWith("C:/plugins/demo")
  })

  it("getPlugin returns null when the manifest can't be read", async () => {
    mockPreview.mockRejectedValueOnce(new Error("nope"))
    const client = createLocalDirectoryClient("C:/plugins/missing")
    const result = await client.getPlugin("demo")
    expect(result).toBeNull()
  })

  it("installPlugin delegates to installPluginFromDirectory with the cached name", async () => {
    mockPreview.mockResolvedValueOnce({
      id: "demo",
      name: "Demo Plugin",
      version: "1.0.0",
      type: "frontend",
    } as never)
    mockInstall.mockResolvedValueOnce({ pluginId: "demo", warnings: [] })
    const client = createLocalDirectoryClient("C:/plugins/demo")
    await client.getPlugin("demo")
    const receipt = await client.installPlugin("demo")
    expect(mockInstall).toHaveBeenCalledWith("C:/plugins/demo", { pluginName: "Demo Plugin" })
    expect(receipt).toMatchObject({ pluginId: "demo" })
  })

  it("installPlugin runs without a cached manifest (skips name hint)", async () => {
    mockInstall.mockResolvedValueOnce({ pluginId: "demo", warnings: [] })
    const client = createLocalDirectoryClient("C:/plugins/demo")
    await client.installPlugin("demo")
    expect(mockInstall).toHaveBeenCalledWith("C:/plugins/demo", { pluginName: undefined })
  })
})
