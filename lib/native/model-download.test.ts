import {
  cancelDownload,
  downloadModel,
  listDownloadProgress,
  subscribeDownloadProgress,
  type ModelDownloadProgress,
} from "./model-download"

describe("native model-download stub", () => {
  test("downloadModel rejects with the documented unavailability message", async () => {
    await expect(downloadModel({ providerId: "ollama", modelId: "llama3" })).rejects.toThrow(
      /Native model downloads are not available yet/
    )
  })

  test("cancelDownload resolves to undefined (no-op)", async () => {
    await expect(
      cancelDownload({ providerId: "ollama", modelId: "llama3" })
    ).resolves.toBeUndefined()
  })

  test("listDownloadProgress resolves to an empty record", async () => {
    await expect(listDownloadProgress()).resolves.toEqual({})
  })

  test("subscribeDownloadProgress returns an unsubscribe function that does nothing", () => {
    const handler = jest.fn<void, [ModelDownloadProgress]>()
    const unsubscribe = subscribeDownloadProgress(handler)
    expect(typeof unsubscribe).toBe("function")
    expect(unsubscribe()).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})
