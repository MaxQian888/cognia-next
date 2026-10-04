/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import type { ContributedPiPackageView } from "@/hooks/plugins/use-contributed-pi-packages"
import type { UsePiPackagesResult } from "@/hooks/plugins/use-pi-packages"
import type { PiPackagesSnapshot } from "@/lib/pi-packages/host"
import { PiPackageResolutionError } from "@/lib/plugin/pi-packages/resolve"
import type { ResolvedContributedPiPackage } from "@/lib/plugin/pi-packages/resolve"
import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"
import messages from "@/i18n/messages/en.json"
import { ContributedPiPackageList } from "./contributed-pi-package-list"

let mockViews: ContributedPiPackageView[] = []
const mockRefresh = jest.fn()
jest.mock("@/hooks/plugins/use-contributed-pi-packages", () => ({
  useContributedPiPackages: () => ({ packages: mockViews, loading: false, refresh: mockRefresh }),
}))

const mockInstall = jest.fn()
const mockRemove = jest.fn()
const mockPrepare = jest.fn()
jest.mock("@/lib/plugin/pi-packages/operations", () => {
  const actual = jest.requireActual("@/lib/plugin/pi-packages/operations")
  return {
    ...actual,
    installPiPackage: (...args: unknown[]) => mockInstall(...args),
    removePiPackage: (...args: unknown[]) => mockRemove(...args),
    preparePiPackage: (...args: unknown[]) => mockPrepare(...args),
  }
})
jest.mock("@/hooks/plugins/use-plugin-display-name", () => ({
  usePluginDisplayName: (id: string | null) =>
    id === "latex-workbench" ? "Pi LaTeX Workbench" : (id ?? ""),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const toastMock = jest.requireMock("sonner").toast as { success: jest.Mock; error: jest.Mock }

const ROOT = "/p/latex-workbench"
const DIR = `${ROOT}/pi`
const REF = "latex-workbench/latex" as const
const TEST_ID = "contributed-pi-package-latex-workbench-latex"

const DEF: PluginPiPackageDef = {
  id: "latex",
  name: "LaTeX workbench",
  description: "Compile LaTeX",
  path: "pi",
  minPiVersion: "0.85.1",
  prepare: { program: "npm", args: ["ci"], marker: "pi/m" },
  hostedSession: {
    extensions: ["pi/latex.ts"],
    tools: ["latex_compile"],
    controlsSession: true,
  },
}

function view(
  overrides: Partial<ResolvedContributedPiPackage> = {},
  def: PluginPiPackageDef = DEF
): ContributedPiPackageView {
  return {
    entry: { def, installRoot: ROOT, pluginId: "latex-workbench", ref: REF },
    resolved: {
      ref: REF,
      pluginId: "latex-workbench",
      def,
      pluginRoot: ROOT,
      packageDir: DIR,
      markerPath: `${ROOT}/pi/m`,
      prepareState: "prepared",
      hosted: Boolean(def.hostedSession),
      extensions: [`${ROOT}/pi/latex.ts`],
      env: {},
      tools: def.hostedSession?.tools ?? [],
      controlsSession: def.hostedSession?.controlsSession === true,
      minPiVersion: def.minPiVersion,
      ...overrides,
    },
    error: null,
  }
}

function pi(
  options: { cli?: boolean; version?: string; user?: string[]; cwd?: string | null } = {}
) {
  const snapshot: PiPackagesSnapshot = {
    user: { packages: options.user ?? [], unparseable: false, missing: false, warnings: [] },
    project: { packages: [], unparseable: false, missing: false, warnings: [] },
    cli: { available: options.cli ?? true, version: options.version ?? "0.85.1" },
    projectCwd: options.cwd === undefined ? "/work" : options.cwd,
    userBaseDir: "/home/me/.pi/agent",
  }
  const reload = jest.fn(async () => undefined)
  return {
    loading: false,
    snapshot,
    resolved: [],
    budget: { total: 0, measured: 0, unmeasured: 0, items: [] },
    overlaps: [],
    discouraged: [],
    piMissing: false,
    warnings: [],
    projectPath: null,
    reload,
    mutate: jest.fn(),
    setEnabled: jest.fn(),
  } as unknown as UsePiPackagesResult
}

function renderList(piResult: UsePiPackagesResult, pluginId?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContributedPiPackageList pi={piResult} pluginId={pluginId} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockViews = [view()]
  mockInstall.mockReset()
  mockRemove.mockReset()
  mockPrepare.mockReset()
  mockRefresh.mockReset()
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

describe("ContributedPiPackageList", () => {
  it("renders nothing without contributed packages", () => {
    mockViews = []
    const { container } = renderList(pi())
    expect(container).toBeEmptyDOMElement()
  })

  it("shows path, version, prepare state, scopes, hosted tools and the controlsSession warning", () => {
    renderList(pi({ user: [DIR] }))
    const row = screen.getByTestId(TEST_ID)
    expect(within(row).getByText("LaTeX workbench")).toBeInTheDocument()
    expect(within(row).getByText("From Pi LaTeX Workbench")).toBeInTheDocument()
    expect(within(row).getByText(DIR)).toBeInTheDocument()
    expect(screen.getByTestId(`${TEST_ID}-min-version`)).toHaveTextContent("Pi ≥ 0.85.1")
    expect(screen.getByTestId(`${TEST_ID}-prepare-state`)).toHaveTextContent("Prepared")
    // Installed in user scope (matched by Pi identity), not in project scope.
    expect(screen.getByTestId(`${TEST_ID}-remove-user`)).toBeInTheDocument()
    expect(screen.getByTestId(`${TEST_ID}-install-project`)).toBeInTheDocument()
    expect(screen.getByTestId(`${TEST_ID}-hosted`)).toHaveTextContent("latex_compile")
    expect(screen.getByTestId(`${TEST_ID}-controls-session`)).toBeInTheDocument()
  })

  it("hides the plugin badge when narrowed to one plugin", () => {
    renderList(pi(), "latex-workbench")
    expect(screen.queryByText("From Pi LaTeX Workbench")).not.toBeInTheDocument()
  })

  it("flags an unmet minPiVersion and the degraded settings-edit path", () => {
    renderList(pi({ cli: false, version: "0.84.0" }))
    expect(screen.getByTestId(`${TEST_ID}-min-version`)).toHaveTextContent(
      "Needs Pi 0.85.1 or newer"
    )
    expect(screen.getByTestId("contributed-pi-packages-degraded")).toBeInTheDocument()
  })

  it("shows a typed refusal instead of actions", () => {
    mockViews = [
      {
        ...view(),
        resolved: null,
        error: new PiPackageResolutionError("not-on-disk", REF, "builtin"),
      },
    ]
    renderList(pi())
    expect(screen.getByTestId(`${TEST_ID}-error`)).toHaveTextContent(
      "built-in plugins can't ship Pi packages"
    )
    expect(screen.queryByTestId(`${TEST_ID}-install-user`)).not.toBeInTheDocument()
  })

  it("marks an install-only package and disables project scope without a workspace", () => {
    mockViews = [view({}, { ...DEF, hostedSession: undefined })]
    renderList(pi({ cwd: null }))
    expect(screen.getByText("Install only")).toBeInTheDocument()
    expect(screen.getByTestId(`${TEST_ID}-install-project`)).toBeDisabled()
  })

  it("installs with the snapshot's workspace and CLI, then reloads", async () => {
    const user = userEvent.setup()
    const piResult = pi()
    mockInstall.mockResolvedValue({ ok: true, plan: { strategy: "pi-cli" } })
    renderList(piResult)
    await user.click(screen.getByTestId(`${TEST_ID}-install-user`))
    await waitFor(() => expect(piResult.reload).toHaveBeenCalled())
    expect(mockInstall).toHaveBeenCalledWith(REF, "user", {
      cwd: "/work",
      cli: { available: true, version: "0.85.1" },
    })
    expect(toastMock.success).toHaveBeenCalledWith("Installed LaTeX workbench (User)")
  })

  it("says when the install only recorded intent", async () => {
    const user = userEvent.setup()
    mockInstall.mockResolvedValue({ ok: true, degradedReason: "pi-unavailable" })
    renderList(pi({ cli: false }))
    await user.click(screen.getByTestId(`${TEST_ID}-install-user`))
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringContaining("Pi loads it on its next launch")
      )
    )
  })

  it("removes from a scope and reports failures with the localized reason", async () => {
    const user = userEvent.setup()
    mockRemove.mockResolvedValue({ ok: false, code: "execution-failed", error: "exit 1" })
    renderList(pi({ user: [DIR] }))
    await user.click(screen.getByTestId(`${TEST_ID}-remove-user`))
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Couldn't remove LaTeX workbench: The operation failed.",
        { description: "exit 1" }
      )
    )
    expect(mockRemove).toHaveBeenCalledWith(REF, "user", expect.anything())
  })

  it("labels each scope through one localized message", () => {
    renderList(pi({ user: [DIR] }))
    expect(screen.getByText("User: Installed")).toBeInTheDocument()
    expect(screen.getByText("Project: Not installed")).toBeInTheDocument()
  })

  it("explains a failed prepare with the program and exit code, and shows its output", async () => {
    const user = userEvent.setup()
    mockPrepare.mockResolvedValue({
      ok: false,
      code: "exit-code",
      exitCode: 2,
      output: "npm ERR! missing script",
      error: "`npm ci` exited 2.",
      plan: {
        ref: REF,
        pluginId: "latex-workbench",
        packageId: "latex",
        program: "npm",
        args: ["ci"],
        cwd: DIR,
        timeoutMs: 300_000,
        commandLine: "npm ci",
      },
    })
    renderList(pi())
    await user.click(screen.getByTestId(`${TEST_ID}-prepare`))
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Couldn't prepare LaTeX workbench: The prepare step (npm) exited with code 2.",
        { description: "npm ERR! missing script" }
      )
    )
  })

  it("shows the exact command before preparing, and runs only on confirm", async () => {
    const user = userEvent.setup()
    mockPrepare.mockImplementation(
      async (_ref: string, options: { confirm: (plan: unknown) => Promise<boolean> }) => {
        const approved = await options.confirm({
          ref: REF,
          pluginId: "latex-workbench",
          packageId: "latex",
          program: "npm",
          args: ["ci"],
          cwd: DIR,
          timeoutMs: 300_000,
          commandLine: "npm ci",
        })
        return approved ? { ok: true } : { ok: false, code: "declined" }
      }
    )
    renderList(pi())
    await user.click(screen.getByTestId(`${TEST_ID}-prepare`))
    expect(await screen.findByTestId("pi-package-prepare-command")).toHaveTextContent("npm ci")
    // The plugin is named, not its id.
    expect(screen.getByTestId("pi-package-prepare-dialog")).toHaveTextContent(
      "Pi LaTeX Workbench needs to install"
    )
    expect(
      within(screen.getByTestId("pi-package-prepare-dialog")).getByText(DIR)
    ).toBeInTheDocument()
    await user.click(screen.getByTestId("pi-package-prepare-confirm"))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Prepared LaTeX workbench"))
    expect(mockRefresh).toHaveBeenCalled()
  })

  it("does nothing further when the prepare dialog is cancelled", async () => {
    const user = userEvent.setup()
    mockPrepare.mockImplementation(
      async (_ref: string, options: { confirm: (plan: unknown) => Promise<boolean> }) => {
        const approved = await options.confirm({
          ref: REF,
          pluginId: "latex-workbench",
          packageId: "latex",
          program: "npm",
          args: ["ci"],
          cwd: DIR,
          timeoutMs: 300_000,
          commandLine: "npm ci",
        })
        return approved ? { ok: true } : { ok: false, code: "declined" }
      }
    )
    renderList(pi())
    await user.click(screen.getByTestId(`${TEST_ID}-prepare`))
    await user.click(await screen.findByText("Cancel"))
    await waitFor(() => expect(mockPrepare).toHaveBeenCalled())
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it("offers prepare when install needs it, then finishes the install", async () => {
    const user = userEvent.setup()
    mockViews = [view({ prepareState: "missing" })]
    mockInstall
      .mockResolvedValueOnce({ ok: false, code: "needs-prepare", prepareState: "missing" })
      .mockResolvedValueOnce({ ok: true, plan: { strategy: "pi-cli" } })
    mockPrepare.mockImplementation(
      async (_ref: string, options: { confirm: (plan: unknown) => Promise<boolean> }) => {
        await options.confirm({
          ref: REF,
          pluginId: "latex-workbench",
          packageId: "latex",
          program: "npm",
          args: ["ci"],
          cwd: DIR,
          timeoutMs: 300_000,
          commandLine: "npm ci",
        })
        return { ok: true }
      }
    )
    renderList(pi())
    await user.click(screen.getByTestId(`${TEST_ID}-install-user`))
    expect(
      await screen.findByText("The package is installed into Pi after this step succeeds.")
    ).toBeInTheDocument()
    await user.click(screen.getByTestId("pi-package-prepare-confirm"))
    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(2))
    expect(toastMock.success).toHaveBeenCalledWith("Installed LaTeX workbench (User)")
  })
})
