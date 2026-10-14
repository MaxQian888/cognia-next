describe("headless runtime roster", () => {
  it("importing the anchor registers the extracted runtimes without error", async () => {
    await jest.isolateModulesAsync(async () => {
      const registry = await import("../registry")
      registry.__resetHeadlessRuntimesForTesting()
      await import("./index")
      const names = registry.listHeadlessRuntimes().map((runtime) => runtime.name)

      expect(names[0]).toBe("host-event-publisher")
      // Sealed provider keys are loaded before anything that can start a run.
      expect(names.indexOf("host-provider-keys")).toBeGreaterThan(0)
      expect(names.indexOf("host-provider-keys")).toBeLessThan(names.indexOf("scheduler"))
      expect(names).toContain("workflow-runtime")
      expect(names).toContain("workflow-trigger-bridge")
      expect(names).toContain("collab-runtime")
      expect(names).toContain("plugin-runtime")
      expect(names).toContain("plugin-tool-dispatch")
      expect(names.indexOf("plugin-runtime")).toBeLessThan(names.indexOf("plugin-tool-dispatch"))
      expect(names.indexOf("plugin-tool-dispatch")).toBeLessThan(names.indexOf("connector-runtime"))
      expect(names).not.toContain("media-generation")
      expect(names).not.toContain("phantom-run-guard")
      expect(names).not.toContain("twin-job-worker")
      expect(new Set(names).size).toBe(names.length)
    })
  })
})
