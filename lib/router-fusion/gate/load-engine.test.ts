import {
  __resetRouterFusionHostForTesting,
  loadRouterFusionHost,
  type RouterFusionHost,
} from "./load-engine"

describe("loadRouterFusionHost", () => {
  afterEach(() => __resetRouterFusionHostForTesting())

  it("turns a failed import into an import_failed fault and retries next time", async () => {
    const importer = jest
      .fn<Promise<RouterFusionHost>, []>()
      .mockRejectedValueOnce(new Error("ChunkLoadError: loading chunk 42 failed"))
      .mockResolvedValueOnce({ marker: true } as unknown as RouterFusionHost)
    await expect(loadRouterFusionHost(importer)).rejects.toMatchObject({
      name: "RouterFusionInfrastructureError",
      code: "import_failed",
    })
    await expect(loadRouterFusionHost(importer)).resolves.toEqual({ marker: true })
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it("loads the host once and shares it", async () => {
    const importer = jest.fn().mockResolvedValue({ marker: 1 } as unknown as RouterFusionHost)
    const [a, b] = await Promise.all([
      loadRouterFusionHost(importer),
      loadRouterFusionHost(importer),
    ])
    expect(a).toBe(b)
    expect(importer).toHaveBeenCalledTimes(1)
  })
})
