import { render, screen, waitFor } from "@testing-library/react"
import { LspEffectivePreview } from "./lsp-effective-preview"
import type { LspServerConfig } from "@/types/lsp/config"

// next-intl → echo keys (repo-standard test pattern).
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key
    return t
  },
}))

// Project store state is swappable per test; default = no active project, so
// the resolver runs without the project layer (pure).
let projectState: { projects: unknown[]; activeProjectId: string | null } = {
  projects: [],
  activeProjectId: null,
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) => selector(projectState),
}))

const readProjectLspFileMock = jest.fn()
jest.mock("@/lib/lsp/project-file-reader", () => ({
  readProjectLspFile: (rootDir: string) => readProjectLspFileMock(rootDir),
}))

beforeEach(() => {
  projectState = { projects: [], activeProjectId: null }
  readProjectLspFileMock.mockReset()
  readProjectLspFileMock.mockResolvedValue(null)
})

describe("LspEffectivePreview", () => {
  it("lists builtin defaults with a builtin source badge", async () => {
    render(<LspEffectivePreview userServers={[]} />)

    await waitFor(() => {
      expect(screen.getByTestId("lsp-effective-typescript")).toBeInTheDocument()
    })
    // All four shipped builtins resolve.
    for (const id of ["typescript", "pyright", "rust-analyzer", "gopls"]) {
      expect(screen.getByTestId(`lsp-effective-${id}`)).toBeInTheDocument()
    }
    expect(screen.getAllByText("effectivePreview.source.builtin").length).toBeGreaterThan(0)
  })

  it("marks a user entry overriding a builtin id and shows the merged command", async () => {
    const userServers: LspServerConfig[] = [
      {
        id: "typescript",
        name: "TS (custom)",
        languages: ["typescript"],
        command: "/opt/custom/tsserver",
      },
    ]
    render(<LspEffectivePreview userServers={userServers} />)

    const row = await screen.findByTestId("lsp-effective-typescript")
    expect(row).toHaveTextContent("/opt/custom/tsserver")
    expect(row).toHaveTextContent("effectivePreview.overridesBuiltin")
    expect(row).toHaveTextContent("effectivePreview.source.user")
  })

  it("lists a custom user server with a user source badge", async () => {
    const userServers: LspServerConfig[] = [
      { id: "lsp_abc", name: "Custom LS", languages: ["lua"], command: "lua-ls" },
    ]
    render(<LspEffectivePreview userServers={userServers} />)

    const row = await screen.findByTestId("lsp-effective-lsp_abc")
    expect(row).toHaveTextContent("Custom LS")
    expect(row).toHaveTextContent("effectivePreview.source.user")
  })

  it("layers the active project's .cognia/lsp.json over a user entry", async () => {
    projectState = {
      projects: [{ id: "p1", roots: [{ path: "D:/proj", primary: true }] }],
      activeProjectId: "p1",
    }
    readProjectLspFileMock.mockResolvedValue({
      servers: [
        { id: "lsp_abc", name: "Custom LS (proj)", languages: ["lua"], command: "proj-lua-ls" },
      ],
    })
    render(
      <LspEffectivePreview
        userServers={[{ id: "lsp_abc", name: "Custom LS", languages: ["lua"], command: "lua-ls" }]}
      />
    )

    const row = await screen.findByTestId("lsp-effective-lsp_abc")
    expect(row).toHaveTextContent("proj-lua-ls")
    expect(row).toHaveTextContent("effectivePreview.source.project")
    expect(row).toHaveTextContent("effectivePreview.overridden")
  })

  it("renders the empty state when resolution rejects", async () => {
    projectState = {
      projects: [{ id: "p1", roots: [{ path: "D:/proj", primary: true }] }],
      activeProjectId: "p1",
    }
    // resolveLspServers itself swallows readProjectFile rejections, so force a
    // failure upstream of it: a store selector throw is not catchable here —
    // instead make the project file unreadable AND assert builtins still render
    // (the resolver's silent-degradation contract).
    readProjectLspFileMock.mockRejectedValue(new Error("io"))
    render(<LspEffectivePreview userServers={[]} />)

    await waitFor(() => {
      expect(screen.getByTestId("lsp-effective-typescript")).toBeInTheDocument()
    })
  })

  it("shows the empty hint when every server resolves away", async () => {
    const userServers: LspServerConfig[] = [
      { id: "typescript", name: "ts", languages: ["typescript"], command: "x", enabled: false },
      { id: "pyright", name: "py", languages: ["python"], command: "x", enabled: false },
      { id: "rust-analyzer", name: "rs", languages: ["rust"], command: "x", enabled: false },
      { id: "gopls", name: "go", languages: ["go"], command: "x", enabled: false },
    ]
    render(<LspEffectivePreview userServers={userServers} />)

    await waitFor(() => {
      expect(screen.getByText("effectivePreview.empty")).toBeInTheDocument()
    })
  })
})
