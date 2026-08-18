/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { UsePiPackagesResult } from "@/hooks/plugins/use-pi-packages"
import { computePiContextBudget } from "@/lib/pi-packages/budget"
import { detectPiOverlaps, piDiscouragedPackages } from "@/lib/pi-packages/conflicts"
import type { PiPackagesSnapshot } from "@/lib/pi-packages/host"
import { resolvePiPackages } from "@/lib/pi-packages/resolve"
import type { PiPackageSource } from "@/lib/pi-packages/types"
import messages from "@/i18n/messages/en.json"
import { AgentPackagesPane } from "./agent-packages-pane"

jest.mock("@/hooks/plugins", () => ({ usePiPackages: () => mockResult }))

// The global next/navigation mock returns empty params; override it so the
// deep-link path (`?piInstall=<spec>`) can be exercised.
const routerReplace = jest.fn()
let mockSearchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/plugins",
  useSearchParams: () => mockSearchParams,
}))

jest.mock("@xyflow/react", () => ({
  ReactFlow: () => <div data-testid="rf-canvas" />,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
}))

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: () => <div data-testid="rc-chart" />,
  Bar: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}))

jest.mock("@monaco-editor/react", () => ({ __esModule: true, default: () => <div /> }))
jest.mock("@/lib/canvas/monaco-loader", () => ({ configureMonacoLoader: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const toastMock = jest.requireMock("sonner").toast as { success: jest.Mock; error: jest.Mock }

let mockResult: UsePiPackagesResult

interface Options {
  loading?: boolean
  user?: readonly PiPackageSource[]
  project?: readonly PiPackageSource[]
  cliAvailable?: boolean
  piMissing?: boolean
  warnings?: string[]
  projectCwd?: string | null
  mutate?: jest.Mock
  setEnabled?: jest.Mock
}

function setup(options: Options = {}): { mutate: jest.Mock; setEnabled: jest.Mock } {
  const user = options.user ?? []
  const project = options.project ?? []
  const resolved = resolvePiPackages(user, project)
  const specs = resolved.map((entry) => entry.pkg)
  const mutate = options.mutate ?? jest.fn(async () => ({ ok: true, plan: { strategy: "pi-cli" } }))
  const setEnabled = options.setEnabled ?? jest.fn(async () => ({ ok: true }))

  const snapshot: PiPackagesSnapshot = {
    user: {
      packages: [...user],
      unparseable: false,
      missing: options.piMissing ?? false,
      warnings: [],
    },
    project: { packages: [...project], unparseable: false, missing: false, warnings: [] },
    cli:
      options.cliAvailable === false
        ? { available: false }
        : { available: true, version: "0.84.1" },
    projectCwd: options.projectCwd === undefined ? "/repo" : options.projectCwd,
    userBaseDir: "/home/u/.pi/agent",
  }

  mockResult = {
    loading: options.loading ?? false,
    snapshot,
    resolved,
    budget: computePiContextBudget(specs),
    overlaps: detectPiOverlaps(specs),
    discouraged: piDiscouragedPackages(specs),
    piMissing: options.piMissing ?? false,
    warnings: options.warnings ?? [],
    projectPath: snapshot.projectCwd ? `${snapshot.projectCwd}/.pi/settings.json` : null,
    reload: jest.fn(async () => undefined),
    mutate: mutate as unknown as UsePiPackagesResult["mutate"],
    setEnabled: setEnabled as unknown as UsePiPackagesResult["setEnabled"],
  }

  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <AgentPackagesPane />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
  return { mutate, setEnabled }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSearchParams = new URLSearchParams()
})

describe("AgentPackagesPane", () => {
  it("shows a loading line and no panels while reading", () => {
    setup({ loading: true })
    expect(screen.getByText(/Reading Pi's settings/i)).toBeInTheDocument()
    expect(screen.queryByTestId("pi-context-budget")).not.toBeInTheDocument()
  })

  it("renders the budget, overlap, installed and catalog panels once loaded", () => {
    setup({ user: ["npm:pi-memory@0.4.2"] })
    expect(screen.getByTestId("pi-context-budget")).toBeInTheDocument()
    expect(screen.getByTestId("pi-overlap-graph")).toBeInTheDocument()
    expect(screen.getByTestId("pi-installed-list")).toBeInTheDocument()
    expect(screen.getByTestId("pi-catalog-list")).toBeInTheDocument()
  })

  it("shows the detected Pi version", () => {
    setup()
    expect(screen.getByText(/Pi 0\.84\.1 on PATH/i)).toBeInTheDocument()
    expect(screen.queryByTestId("pi-cli-missing")).not.toBeInTheDocument()
  })

  /** The fallback works, so this is a notice about weaker behaviour, not an error. */
  it("explains the degraded path when Pi's CLI is missing", () => {
    setup({ cliAvailable: false })
    expect(screen.getByTestId("pi-cli-missing")).toHaveTextContent(/does not download anything/i)
  })

  it("tells the user Pi is not set up when the settings file is absent", () => {
    setup({ piMissing: true })
    expect(screen.getByTestId("pi-missing")).toBeInTheDocument()
  })

  it("surfaces parse warnings from either scope", () => {
    setup({ warnings: ['Entry "npm:x" has fields Pi 0.84.1 does not define: enabled.'] })
    expect(screen.getByTestId("pi-warnings")).toHaveTextContent(/does not define: enabled/i)
  })

  it("calls out installed packages the review discourages", () => {
    setup({ user: ["npm:pi-finish-notification@1.0.4"] })
    expect(screen.getByTestId("pi-discouraged")).toHaveTextContent("pi-finish-notification")
  })

  it("says project scope is unavailable with no workspace open", () => {
    setup({ projectCwd: null })
    expect(screen.getByText(/Open a workspace folder/i)).toBeInTheDocument()
  })

  /** Install must pass the gate; clicking a catalog row only opens the dialog. */
  it("opens the pre-install dialog instead of installing straight away", async () => {
    const { mutate } = setup()
    await userEvent.click(screen.getByTestId("pi-catalog-install-pi-memory"))
    expect(screen.getByTestId("pi-install-dialog")).toBeInTheDocument()
    expect(mutate).not.toHaveBeenCalled()
  })

  it("installs at user scope after the dialog is confirmed", async () => {
    const { mutate } = setup()
    await userEvent.click(screen.getByTestId("pi-catalog-install-pi-memory"))
    await userEvent.click(screen.getByTestId("pi-install-confirm"))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        kind: "install",
        spec: "npm:pi-memory@0.4.2",
        scope: "user",
      })
    )
    expect(toastMock.success).toHaveBeenCalled()
  })

  it("does not mutate when the dialog is cancelled", async () => {
    const { mutate } = setup()
    await userEvent.click(screen.getByTestId("pi-catalog-install-pi-memory"))
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mutate).not.toHaveBeenCalled()
    expect(screen.queryByTestId("pi-install-dialog")).not.toBeInTheDocument()
  })

  it("reports a failed install as an error", async () => {
    const mutate = jest.fn(async () => ({
      ok: false,
      plan: { strategy: "pi-cli" as const },
      error: "exited 1",
    }))
    setup({ mutate })
    await userEvent.click(screen.getByTestId("pi-catalog-install-pi-memory"))
    await userEvent.click(screen.getByTestId("pi-install-confirm"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("removes a package through the hook", async () => {
    const { mutate } = setup({ user: ["npm:pi-memory@0.4.2"] })
    await userEvent.click(screen.getByRole("button", { name: /remove/i }))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        kind: "remove",
        spec: "npm:pi-memory@0.4.2",
        scope: "user",
      })
    )
  })

  it("toggles a package to inert through the hook", async () => {
    const { setEnabled } = setup({ user: ["npm:pi-memory@0.4.2"] })
    await userEvent.click(screen.getByRole("switch"))
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith("npm:pi-memory@0.4.2", "user", false)
    )
  })

  /**
   * Each `pi install` rewrites the same `settings.json`, so running a preset in
   * parallel would race and lose entries. The calls must be sequential.
   */
  it("applies a preset one package at a time", async () => {
    const order: string[] = []
    const mutate = jest.fn(async (request: { spec: string }) => {
      order.push(`start:${request.spec}`)
      await Promise.resolve()
      order.push(`end:${request.spec}`)
      return { ok: true, plan: { strategy: "pi-cli" as const } }
    })
    setup({ mutate })
    await userEvent.click(screen.getByTestId("pi-preset-apply-starter"))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].replace("start:", "")).toBe(order[i + 1].replace("end:", ""))
    }
  })

  /** A partial result is reported as partial, never as success. */
  it("reports a partially-applied preset as an error", async () => {
    let calls = 0
    const mutate = jest.fn(async () => {
      calls += 1
      return { ok: calls === 1, plan: { strategy: "pi-cli" as const }, error: "boom" }
    })
    setup({ mutate })
    await userEvent.click(screen.getByTestId("pi-preset-apply-starter"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  /**
   * ⌘K and the external-agent settings entry both land here with the spec in
   * the URL. The deep link chooses a package; it must never install one.
   */
  it("opens the pre-install gate for a spec staged in the URL", async () => {
    mockSearchParams = new URLSearchParams(
      "section=agent-packages&piInstall=npm%3Api-memory%400.4.2"
    )
    const { mutate } = setup()
    expect(screen.getByTestId("pi-install-dialog")).toBeInTheDocument()
    expect(screen.getByText("npm:pi-memory@0.4.2")).toBeInTheDocument()
    expect(mutate).not.toHaveBeenCalled()
  })

  it("ignores a blank piInstall param", () => {
    mockSearchParams = new URLSearchParams("piInstall=")
    setup()
    expect(screen.queryByTestId("pi-install-dialog")).not.toBeInTheDocument()
  })

  /** Otherwise a reload, or Back into this route, reopens what was dismissed. */
  it("strips the param and closes when the staged install is cancelled", async () => {
    mockSearchParams = new URLSearchParams(
      "section=agent-packages&piInstall=npm%3Api-memory%400.4.2"
    )
    setup()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByTestId("pi-install-dialog")).not.toBeInTheDocument()
    expect(routerReplace).toHaveBeenCalledWith("/plugins?section=agent-packages", { scroll: false })
  })

  it("strips the param after a staged install is confirmed", async () => {
    mockSearchParams = new URLSearchParams("piInstall=npm%3Api-memory%400.4.2")
    const { mutate } = setup()
    await userEvent.click(screen.getByTestId("pi-install-confirm"))
    await waitFor(() => expect(mutate).toHaveBeenCalled())
    expect(routerReplace).toHaveBeenCalledWith("/plugins", { scroll: false })
    expect(screen.queryByTestId("pi-install-dialog")).not.toBeInTheDocument()
  })

  it("opens the config editor for a package with reviewed defaults", async () => {
    setup({ user: ["npm:@narumitw/pi-statusline@0.49.6"] })
    await userEvent.click(screen.getByRole("button", { name: /configure/i }))
    expect(screen.getByTestId("pi-config-editor")).toBeInTheDocument()
  })
})
