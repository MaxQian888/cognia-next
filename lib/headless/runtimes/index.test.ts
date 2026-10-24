describe("headless runtime roster", () => {
  it("importing the anchor registers the extracted runtimes without error", async () => {
    await jest.isolateModulesAsync(async () => {
      const registry = await import("../registry")
      registry.__resetHeadlessRuntimesForTesting()
      await import("./index")
      const names = registry.listHeadlessRuntimes().map((runtime) => runtime.name)

      const required = registry
        .listHeadlessRuntimes()
        .filter((runtime) => runtime.criticality === "required")
        .map((runtime) => runtime.name)
      expect(required.sort()).toEqual(
        [
          "automation-policy",
          "background-task",
          "bot-delivery-runner",
          "connector-runtime",
          "desktop-message-source",
          "desktop-sync-source",
          "external-agent",
          "host-event-publisher",
          "host-provider-keys",
          "plugin-runtime",
          "plugin-tool-dispatch",
          "provider-core-runtime",
          "routing-runtime",
          "scheduler",
          "template-trust-reconciliation",
          "work-submission-outbox",
          "workflow-exit-lease-release",
          "workflow-runtime",
          "workflow-trigger-bridge",
        ].sort()
      )
      expect(
        registry
          .listHeadlessRuntimes()
          .every(
            (runtime) => runtime.criticality === "required" || runtime.criticality === "optional"
          )
      ).toBe(true)
      expect(names).toHaveLength(41)
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

  it("starts only data runtimes and the gated terminal listener in a person brain", async () => {
    await jest.isolateModulesAsync(async () => {
      const registry = await import("../registry")
      registry.__resetHeadlessRuntimesForTesting()
      const { PERSON_BRAIN_RUNTIMES } = await import("./index")
      const personal = registry
        .listHeadlessRuntimes()
        .filter((runtime) => runtime.hosts.includes("person-brain"))
        .map((runtime) => runtime.name)
      expect([...PERSON_BRAIN_RUNTIMES].sort()).toEqual([
        "desktop-message-source",
        "desktop-sync-source",
        "host-event-publisher",
        "work-submission-outbox",
      ])
      expect(personal.sort()).toEqual([...PERSON_BRAIN_RUNTIMES].sort())
      expect(personal).toEqual(expect.arrayContaining(["work-submission-outbox"]))
      expect(personal).not.toEqual(expect.arrayContaining(["host-provider-keys", "plugin-runtime"]))
      // Each is also a Host-brain runtime: the profile only subtracts.
      for (const runtime of registry.listHeadlessRuntimes()) {
        expect(runtime.hosts).toContain("brain")
      }
    })
  })

  it("keeps browser startup recovery out of the headless runtime", async () => {
    await jest.isolateModulesAsync(async () => {
      const registry = await import("../registry")
      registry.__resetHeadlessRuntimesForTesting()
      await import("./index")
      expect(registry.listHeadlessRuntimes().map((runtime) => runtime.name)).not.toContain(
        "startup-recovery"
      )
    })
  })
})
