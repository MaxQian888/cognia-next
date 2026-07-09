import { healthcheckScaffold } from "./scaffold-healthcheck"
import { scaffoldPlugin, type PluginScaffoldOptions } from "./templates"

const options: PluginScaffoldOptions = {
  id: "acme-widgets",
  name: "Acme Widgets",
  description: "Widgets for Acme",
  type: "frontend",
  capabilities: ["tools"],
  author: { name: "Acme" },
} as PluginScaffoldOptions

function healthyFiles(): Map<string, string> {
  return scaffoldPlugin(options)
}

describe("healthcheckScaffold", () => {
  it("passes a freshly scaffolded basic plugin", () => {
    const report = healthcheckScaffold(healthyFiles())
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([])
    expect(report.ok).toBe(true)
  })

  it("errors when plugin.json is missing", () => {
    const files = healthyFiles()
    files.delete("plugin.json")
    const report = healthcheckScaffold(files)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === "manifest_missing")).toBe(true)
  })

  it("errors on unparsable manifest JSON", () => {
    const files = healthyFiles()
    files.set("plugin.json", "{ not json")
    const report = healthcheckScaffold(files)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === "manifest_unparsable")).toBe(true)
  })

  it("errors when the manifest fails validation (bad id)", () => {
    const files = healthyFiles()
    const manifest = JSON.parse(files.get("plugin.json") as string)
    manifest.id = "Not A Valid Id!!"
    files.set("plugin.json", JSON.stringify(manifest))
    const report = healthcheckScaffold(files)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === "manifest_invalid")).toBe(true)
  })

  it("errors when manifest.main points at a file the scaffold did not emit", () => {
    const files = healthyFiles()
    files.delete("index.ts")
    const report = healthcheckScaffold(files)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === "main_missing")).toBe(true)
  })

  it("errors on surviving {{placeholder}} template residue", () => {
    const files = healthyFiles()
    files.set("README.md", "# {{name}} left unexpanded")
    const report = healthcheckScaffold(files)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === "template_residue")).toBe(true)
  })

  it("warns (not errors) when a declared capability has no registration marker", () => {
    const files = healthyFiles()
    // Strip the tools registration from the entry while keeping the manifest claim.
    files.set("index.ts", "export default { activate() { return {} } }")
    const report = healthcheckScaffold(files)
    const unwired = report.issues.find((i) => i.code === "capability_unwired")
    expect(unwired?.severity).toBe("warning")
    // Warnings alone never fail the scaffold.
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([])
    expect(report.ok).toBe(true)
  })
})

it("passes a basic python scaffold (pythonMain entry present)", () => {
  const files = scaffoldPlugin({ ...options, type: "python", capabilities: ["python"] })
  const report = healthcheckScaffold(files)
  expect(report.issues.filter((i) => i.severity === "error")).toEqual([])
  expect(report.ok).toBe(true)
})
