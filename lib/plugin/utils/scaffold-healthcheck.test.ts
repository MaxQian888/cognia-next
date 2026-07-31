import { healthcheckScaffold } from "./scaffold-healthcheck"

function healthyFiles(type: "frontend" | "python" = "frontend"): Map<string, string> {
  const manifest = {
    id: "acme-widgets",
    name: "Acme Widgets",
    version: "0.1.0",
    description: "Widgets for Acme",
    type,
    capabilities: type === "python" ? ["python"] : ["tools"],
    author: { name: "Acme" },
    engines: { cognia: ">=0.1.0" },
    permissions: type === "python" ? ["python:execute"] : [],
    ...(type === "python" ? { pythonMain: "main.py" } : { main: "index.ts" }),
  }
  return new Map([
    ["plugin.json", JSON.stringify(manifest)],
    [
      type === "python" ? "main.py" : "index.ts",
      type === "python" ? "@tool\ndef run(): pass" : "registerPluginTools([])",
    ],
  ])
}

describe("healthcheckScaffold", () => {
  it("passes a valid frontend file map", () => {
    const report = healthcheckScaffold(healthyFiles())
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(report.ok).toBe(true)
  })

  it("errors when plugin.json is missing", () => {
    const files = healthyFiles()
    files.delete("plugin.json")
    expect(
      healthcheckScaffold(files).issues.some((issue) => issue.code === "manifest_missing")
    ).toBe(true)
  })

  it("errors on invalid JSON and invalid manifests", () => {
    const invalidJson = healthyFiles()
    invalidJson.set("plugin.json", "{ not json")
    expect(
      healthcheckScaffold(invalidJson).issues.some((issue) => issue.code === "manifest_unparsable")
    ).toBe(true)

    const invalidManifest = healthyFiles()
    const manifest = JSON.parse(invalidManifest.get("plugin.json") as string)
    manifest.id = "Not Valid"
    invalidManifest.set("plugin.json", JSON.stringify(manifest))
    expect(
      healthcheckScaffold(invalidManifest).issues.some((issue) => issue.code === "manifest_invalid")
    ).toBe(true)
  })

  it("errors when the declared entry is absent", () => {
    const files = healthyFiles()
    files.delete("index.ts")
    expect(healthcheckScaffold(files).issues.some((issue) => issue.code === "main_missing")).toBe(
      true
    )
  })

  it("errors on template residue", () => {
    const files = healthyFiles()
    files.set("README.md", "# {{name}}")
    expect(
      healthcheckScaffold(files).issues.some((issue) => issue.code === "template_residue")
    ).toBe(true)
  })

  it("reports an unwired capability as a warning", () => {
    const files = healthyFiles()
    files.set("index.ts", "export default {}")
    const report = healthcheckScaffold(files)
    expect(report.issues.find((issue) => issue.code === "capability_unwired")?.severity).toBe(
      "warning"
    )
    expect(report.ok).toBe(true)
  })

  it("accepts a valid Python file map", () => {
    expect(healthcheckScaffold(healthyFiles("python")).ok).toBe(true)
  })
})
