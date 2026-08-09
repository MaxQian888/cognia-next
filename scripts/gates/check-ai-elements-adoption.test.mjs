import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { auditAdoption, OFFICIAL_COMPONENTS } from "./check-ai-elements-adoption.mjs"

function manifest() {
  return {
    components: OFFICIAL_COMPONENTS.map((name) =>
      ["edge", "jsx-preview", "open-in-chat", "transcription"].includes(name)
        ? { name, status: "excluded", reason: "Not compatible with the product boundary." }
        : { name, status: "adopted", consumers: [`components/${name}.tsx`] }
    ),
  }
}

function fixture(overrides = {}) {
  const files = new Map()
  for (const entry of manifest().components) {
    if (entry.status !== "adopted") continue
    files.set(`components/ai-elements/${entry.name}.tsx`, "export {}")
    files.set(
      entry.consumers[0],
      `import { Example } from "@/components/ai-elements/${entry.name}"
export const Fixture = () => <Example />`
    )
  }
  return {
    root: "/repo",
    exists: (file) => files.has(file.replace("/repo/", "")),
    read: (file) => files.get(file.replace("/repo/", "")) ?? "",
    ...overrides,
  }
}

describe("AI Elements adoption audit", () => {
  it("accepts 44 real production consumers and four documented exclusions", () => {
    assert.deepEqual(auditAdoption({ manifest: manifest(), ...fixture() }), [])
  })

  it("rejects an adopted primitive referenced only by a test", () => {
    const value = manifest()
    value.components.find((entry) => entry.name === "agent").consumers = [
      "components/agent.test.tsx",
    ]
    const errors = auditAdoption({ manifest: value, ...fixture() })
    assert.ok(errors.includes("No declared production consumer imports agent"))
  })

  it("rejects every invalid declared production consumer", () => {
    const value = manifest()
    value.components
      .find((entry) => entry.name === "agent")
      .consumers.push("components/agent-secondary.tsx")
    const base = fixture()
    const secondary = "/repo/components/agent-secondary.tsx"
    const errors = auditAdoption({
      manifest: value,
      ...base,
      exists: (file) => file === secondary || base.exists(file),
      read: (file) =>
        file === secondary ? "export const AgentSecondary = () => null" : base.read(file),
    })
    assert.ok(
      errors.includes(
        "Declared production consumer does not import agent: components/agent-secondary.tsx"
      )
    )
  })

  it("rejects import-only adoption without rendered JSX", () => {
    const value = manifest()
    const base = fixture()
    const consumer = "/repo/components/agent.tsx"
    const errors = auditAdoption({
      manifest: value,
      ...base,
      read: (file) =>
        file === consumer
          ? 'import { Example } from "@/components/ai-elements/agent"'
          : base.read(file),
    })
    assert.ok(
      errors.includes("Declared production consumer does not render agent: components/agent.tsx")
    )
  })

  it("rejects missing files and undocumented exclusions", () => {
    const value = manifest()
    value.components.find((entry) => entry.name === "edge").reason = ""
    const base = fixture()
    const errors = auditAdoption({
      manifest: value,
      ...base,
      exists: (file) => !file.endsWith("agent.tsx") && base.exists(file),
    })
    assert.ok(errors.includes("Adopted component file is missing: agent"))
    assert.ok(errors.includes("Excluded component has no reason: edge"))
  })
})
