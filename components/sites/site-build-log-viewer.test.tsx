import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
const copy = jest.fn(async () => true)
jest.mock("@/hooks/ui", () => ({ useCopy: () => ({ copy, copied: false, isCopying: false }) }))

const buildLogs = jest.fn(() => ({ logs: [] as unknown[], loading: false }))
jest.mock("@/hooks/sites/use-site-build-logs", () => ({
  useSiteBuildLogs: (versionId: string | null) => buildLogs(versionId),
}))

import type { SiteBuildLogRow } from "@/types/sites"
import { SiteBuildLogViewer } from "./site-build-log-viewer"

function log(overrides: Partial<SiteBuildLogRow> = {}): SiteBuildLogRow {
  return {
    id: "ver_1:build",
    versionId: "ver_1",
    siteId: "site_1",
    operationId: "op_1",
    phase: "build",
    argv: ["pnpm", "build"],
    exitCode: 0,
    durationSeconds: 12.5,
    timedOut: false,
    truncated: false,
    stdout: "built 42 modules",
    stderr: "",
    storedBytes: 16,
    createdAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  buildLogs.mockReturnValue({ logs: [], loading: false })
})

async function open() {
  const user = userEvent.setup()
  render(<SiteBuildLogViewer versionId="ver_1" label="v1 · abc1234" />)
  await user.click(screen.getByTestId("site-build-log-ver_1"))
  return user
}

it("reads nothing until the viewer is opened", () => {
  // Build logs are the biggest rows in the subsystem after the archives; that
  // is the whole reason they are not on the version row.
  render(<SiteBuildLogViewer versionId="ver_1" label="v1" />)
  expect(buildLogs).toHaveBeenCalledWith(null)
})

it("queries the version once opened", async () => {
  await open()
  expect(buildLogs).toHaveBeenLastCalledWith("ver_1")
})

it("shows the captured output with its exit code and duration", async () => {
  buildLogs.mockReturnValue({ logs: [log()], loading: false })
  await open()
  expect(screen.getByTestId("site-build-log-body")).toHaveTextContent("built 42 modules")
  expect(screen.getByText('buildLog.exitCode:{"code":0}')).toBeInTheDocument()
  expect(screen.getByText('buildLog.duration:{"seconds":"12.5"}')).toBeInTheDocument()
})

it("switches between the phases that recorded output", async () => {
  buildLogs.mockReturnValue({
    logs: [log({ id: "ver_1:install", phase: "install", stdout: "resolving packages" }), log()],
    loading: false,
  })
  const user = await open()
  expect(screen.getByTestId("site-build-log-body")).toHaveTextContent("resolving packages")
  await user.click(screen.getByRole("radio", { name: "buildLog.phase.build" }))
  expect(screen.getByTestId("site-build-log-body")).toHaveTextContent("built 42 modules")
})

it("narrows to stderr, and says so when there is none", async () => {
  buildLogs.mockReturnValue({
    logs: [log({ stderr: "warning: deprecated api" })],
    loading: false,
  })
  const user = await open()
  await user.click(screen.getByRole("switch"))
  const body = screen.getByTestId("site-build-log-body")
  expect(body).toHaveTextContent("warning: deprecated api")
  expect(body).not.toHaveTextContent("built 42 modules")
})

it("says when the stored output was trimmed", async () => {
  buildLogs.mockReturnValue({ logs: [log({ truncated: true })], loading: false })
  await open()
  expect(screen.getByTestId("site-build-log-truncated")).toBeInTheDocument()
})

it("marks a failing exit code and keeps a timeout distinguishable", async () => {
  buildLogs.mockReturnValue({
    logs: [log({ exitCode: 1, timedOut: true, stderr: "TS2304" })],
    loading: false,
  })
  await open()
  expect(screen.getByText('buildLog.exitCode:{"code":1}')).toBeInTheDocument()
  expect(screen.getByText("buildLog.timedOut")).toBeInTheDocument()
})

it("says so when a build recorded nothing", async () => {
  await open()
  expect(screen.getByText("buildLog.empty")).toBeInTheDocument()
})

it("shows a skeleton rather than an empty state while loading", async () => {
  // "Nothing was recorded" and "still reading" must not paint the same thing.
  buildLogs.mockReturnValue({ logs: [], loading: true })
  await open()
  expect(screen.getByTestId("site-build-log-loading")).toBeInTheDocument()
  expect(screen.queryByText("buildLog.empty")).not.toBeInTheDocument()
})

it("copies exactly what is on screen", async () => {
  buildLogs.mockReturnValue({ logs: [log()], loading: false })
  const user = await open()
  await user.click(screen.getByRole("button", { name: "buildLog.copy" }))
  expect(copy).toHaveBeenCalledWith("built 42 modules")
})
