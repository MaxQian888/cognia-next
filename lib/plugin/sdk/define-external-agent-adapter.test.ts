import { defineExternalAgentAdapter } from "./define-external-agent-adapter"

describe("defineExternalAgentAdapter", () => {
  it("returns the adapter definition unchanged (pure pass-through)", () => {
    const def = defineExternalAgentAdapter({
      id: "demo-echo",
      label: "Demo Echo Protocol",
      description: "A reference external-agent protocol adapter.",
      entry: "src/demo-adapter.ts",
      export: "createDemoEchoAdapter",
    })
    expect(def).toMatchObject({ id: "demo-echo", export: "createDemoEchoAdapter" })
    expect(def.entry).toBe("src/demo-adapter.ts")
  })
})
