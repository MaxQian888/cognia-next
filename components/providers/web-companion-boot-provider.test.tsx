import { render, waitFor } from "@testing-library/react"

const replaceMock = jest.fn()
let pathnameValue = "/"
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => pathnameValue,
}))

let platformValue = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

const hydrateMock = jest.fn()
jest.mock("@/lib/tauri/transport-companion", () => ({
  hydrateCompanionConfig: (...args: unknown[]) => hydrateMock(...args),
}))

const runSyncDownMock = jest.fn()
const foregroundTeardown = jest.fn()
const eventTeardown = jest.fn()
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (...args: unknown[]) => runSyncDownMock(...args),
  installForegroundSync: () => foregroundTeardown,
  installEventDrivenSync: () => eventTeardown,
}))

import { WebCompanionBootProvider } from "./web-companion-boot-provider"

const ENV_KEY = "NEXT_PUBLIC_COGNIA_SERVER_URL"

beforeEach(() => {
  platformValue = "web"
  pathnameValue = "/"
  process.env[ENV_KEY] = "https://cloud.example.com:7890"
  hydrateMock.mockResolvedValue(null)
  runSyncDownMock.mockResolvedValue(undefined)
})

afterEach(() => {
  delete process.env[ENV_KEY]
  window.localStorage.clear()
  jest.clearAllMocks()
})

describe("WebCompanionBootProvider", () => {
  it("redirects an unpaired browser with a configured server to /pair", async () => {
    render(
      <WebCompanionBootProvider>
        <div>child</div>
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/pair"))
    expect(runSyncDownMock).not.toHaveBeenCalled()
  })

  it("does not redirect away from onboarding routes", async () => {
    pathnameValue = "/pair"
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(hydrateMock).toHaveBeenCalled())
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("paired: runs sync-down and installs the sync listeners", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      deviceJwt: "jwt",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalled())
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("no-op off web platforms and without a companion target", async () => {
    platformValue = "tauri"
    const { unmount } = render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    unmount()

    platformValue = "web"
    delete process.env[ENV_KEY]
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(hydrateMock).not.toHaveBeenCalled()
  })
})
