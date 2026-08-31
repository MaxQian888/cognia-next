describe("headless runtime roster", () => {
  it("importing the anchor registers the extracted runtimes without error", async () => {
    await jest.isolateModulesAsync(async () => {
      const registry = await import("../registry")
      registry.__resetHeadlessRuntimesForTesting()
      await import("./index")
      const names = registry.listHeadlessRuntimes().map((runtime) => runtime.name)

      expect(names[0]).toBe("host-event-publisher")
      expect(names).toContain("workflow-runtime")
      expect(names).toContain("workflow-trigger-bridge")
      expect(names).not.toContain("twin-job-worker")
      expect(new Set(names).size).toBe(names.length)
    })
  })
})
