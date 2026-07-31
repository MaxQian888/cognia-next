import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { auditPluginSurfaces, PLUGIN_SURFACE_HOSTS, runCli } from "./audit-plugin-surfaces"

const REPO_ROOT = path.resolve(__dirname, "../..")

/** Materialize a throwaway repo whose hosts are supplied by `bodies`. */
function withFixture(
  bodies: Record<string, string>,
  assert: (report: ReturnType<typeof auditPluginSurfaces>) => void
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-surface-audit-"))
  try {
    for (const [file, host] of Object.entries(PLUGIN_SURFACE_HOSTS)) {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const body =
        bodies[file] ??
        // Default: the declared surface count, each wrapping every declared
        // plugin node, so only the file under test can produce an error.
        `export function Host(){return <div>${"<PluginSurface>"
          .concat(host.pluginNodes.map((n) => `<${n} />`).join(""))
          .concat("</PluginSurface>")
          .repeat(host.surfaces)}</div>}`
      fs.writeFileSync(target, body)
    }
    assert(auditPluginSurfaces(root))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("auditPluginSurfaces", () => {
  it("keeps the production view-container panel in the enforced host inventory", () => {
    expect(PLUGIN_SURFACE_HOSTS["components/shell/plugin-view-container-panel.tsx"]).toEqual({
      surfaces: 1,
      pluginNodes: ["PluginViewHost"],
    })
  })

  it("passes when every declared plugin node sits inside a surface", () => {
    withFixture({}, (report) => {
      expect(report.errors).toEqual([])
      expect(report.ok).toBe(true)
    })
  })

  it("requires both inline and overflow extension render paths to be wrapped", () => {
    withFixture(
      {
        "components/plugins/plugin-extension-slot-with-overflow.tsx":
          "export function Host(){return <div><PluginSurface><ext.component /></PluginSurface></div>}",
      },
      (report) => {
        expect(report.ok).toBe(false)
        expect(report.errors).toContain(
          "[surface-count] components/plugins/plugin-extension-slot-with-overflow.tsx renders 1 <PluginSurface> node(s); expected 2"
        )
      }
    )
  })

  // The hole the count check alone could not see: the right number of surfaces,
  // but one branch renders the plugin bare beside them.
  it("fails a plugin node rendered outside the surface even when the count is right", () => {
    withFixture(
      {
        "components/chat/message-renderer.tsx":
          "export function Host({alt}){return alt ? <PluginRenderer /> : <PluginSurface><div/></PluginSurface>}",
      },
      (report) => {
        expect(report.ok).toBe(false)
        expect(report.errors).toContain(
          "[unwrapped-plugin-node] components/chat/message-renderer.tsx:1 renders <PluginRenderer> outside <PluginSurface>"
        )
        // The count itself was satisfied — only the ancestry check caught this.
        expect(report.errors.some((e) => e.startsWith("[surface-count] components/chat"))).toBe(
          false
        )
      }
    )
  })

  it("accepts a plugin node built into a local that a surface renders", () => {
    withFixture(
      {
        "components/plugins/plugin-view-host.tsx":
          "export function Host(){let content; content = <PluginCustomViewHost />; content = <PluginTreeViewHost />; content = <PluginWebviewHost />; return <PluginSurface>{content}</PluginSurface>}",
      },
      (report) => {
        expect(
          report.errors.filter((e) => e.includes("components/plugins/plugin-view-host.tsx"))
        ).toEqual([])
      }
    )
  })

  it("accepts a host-local surface wrapper", () => {
    withFixture(
      {
        "components/context-workbench/context-workbench.tsx":
          "export function Host(){const rendererContent = <Renderer />; return <PluginContextPanelSurface>{rendererContent}</PluginContextPanelSurface>}",
      },
      (report) => {
        // No PluginSurface of its own in this fixture, so the count fails —
        // but the wrapping check must not also complain.
        expect(
          report.errors.filter((e) => e.startsWith("[unwrapped-plugin-node] components/context"))
        ).toEqual([])
      }
    )
  })

  it("flags a declared plugin node the host stopped rendering", () => {
    withFixture(
      {
        "components/plugins/dialogs/plugin-modal-root.tsx":
          "export function Host(){return <PluginSurface><div/></PluginSurface>}",
      },
      (report) => {
        expect(report.ok).toBe(false)
        expect(report.errors).toContain(
          "[stale-plugin-node] components/plugins/dialogs/plugin-modal-root.tsx declares <Component> as a plugin render site but no longer renders it"
        )
      }
    )
  })

  it("still rejects a host-local error boundary shadowing the surface", () => {
    withFixture(
      {
        "components/chat/message-parts/mcp-tool-card.tsx":
          "class PluginPartErrorBoundary {}\nexport function Host(){return <PluginSurface><PluginCard /></PluginSurface>}",
      },
      (report) => {
        expect(report.errors).toContain(
          "[shadow-boundary] components/chat/message-parts/mcp-tool-card.tsx defines PluginPartErrorBoundary; plugin failures belong to PluginSurface"
        )
      }
    )
  })

  it("reports a missing host file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-surface-audit-empty-"))
    try {
      const report = auditPluginSurfaces(root)
      expect(report.ok).toBe(false)
      expect(report.errors).toContain("[host-missing] components/plugins/plugin-extension-slot.tsx")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("audits the real hosts in this repo", () => {
    const report = auditPluginSurfaces(REPO_ROOT)
    expect(report.errors).toEqual([])
  })
})

describe("runCli", () => {
  let written: string[]
  let write: jest.SpyInstance

  beforeEach(() => {
    written = []
    write = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
  })

  afterEach(() => write.mockRestore())

  it("prints a PASS summary and exits 0 on the real repo", () => {
    expect(runCli([], REPO_ROOT)).toBe(0)
    expect(written.join("")).toContain("Plugin surface audit: PASS")
  })

  it("emits the machine report under --json", () => {
    expect(runCli(["--json"], REPO_ROOT)).toBe(0)
    expect(JSON.parse(written.join("")).hosts).toHaveLength(
      Object.keys(PLUGIN_SURFACE_HOSTS).length
    )
  })

  it("exits 1 and lists each error when the audit fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-surface-audit-cli-"))
    try {
      expect(runCli([], root)).toBe(1)
      const out = written.join("")
      expect(out).toContain("Plugin surface audit: FAIL")
      expect(out).toContain("- [host-missing] components/plugins/plugin-extension-slot.tsx")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
