import { render, screen } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { PluginManifestReconstruction } from "./plugin-manifest-reconstruction"

describe("PluginManifestReconstruction", () => {
  it("carries the reconstruction marker", () => {
    render(<PluginManifestReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(en.reconstruction.label)).toBeInTheDocument()
  })

  it("shows what the plugin contributes and every permission it declares", () => {
    render(<PluginManifestReconstruction copy={en.reconstruction} />)
    for (const capability of DEMO_TASK.plugin.capabilities) {
      expect(screen.getByText(capability)).toBeInTheDocument()
    }
    for (const permission of DEMO_TASK.plugin.permissions) {
      expect(screen.getByText(permission)).toBeInTheDocument()
    }
  })

  it("shows the undeclared call refused, and says so in words", () => {
    render(<PluginManifestReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(DEMO_TASK.plugin.denied)).toHaveClass("line-through")
    expect(screen.getByText(en.reconstruction.plugin.deniedNote)).toBeInTheDocument()
  })

  it("is read from a manifest that ships in the repository, not invented", () => {
    // The page claims the declaration can be read before installing. If the
    // fixture drifts from the real manifest, the reconstruction becomes a
    // mock-up of a plugin that does not exist.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "../../../plugins/web-tools/plugin.json"), "utf8")
    ) as { id: string; capabilities: string[]; permissions: string[] }
    expect(manifest.id).toBe(DEMO_TASK.plugin.id)
    expect(manifest.capabilities).toEqual(DEMO_TASK.plugin.capabilities)
    expect(manifest.permissions).toEqual(DEMO_TASK.plugin.permissions)
    expect(manifest.permissions).not.toContain(DEMO_TASK.plugin.denied)
  })

  it("localises", () => {
    render(<PluginManifestReconstruction copy={zh.reconstruction} />)
    expect(screen.getByText(zh.reconstruction.plugin.deniedLabel)).toBeInTheDocument()
    expect(screen.getAllByText(zh.reconstruction.plugin.grantedLabel).length).toBe(
      DEMO_TASK.plugin.permissions.length
    )
  })
})
