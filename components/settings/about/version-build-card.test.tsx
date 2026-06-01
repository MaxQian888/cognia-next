/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const getBuildInfoMock = jest.fn(() => ({
  commit: "abc1234",
  buildTime: "2026-05-30T12:00:00.000Z",
}))
const getRuntimeVersionsMock = jest.fn(async () => ({
  tauri: "2.9.0",
  react: "19.2.0",
  engine: "Chromium 130.0.0.0",
}))
const getNativeBuildNumberMock = jest.fn(async (_locale?: unknown) => null as string | null)
jest.mock("@/lib/app-metadata", () => ({
  APP_VERSION: "9.9.9",
  getBuildInfo: () => getBuildInfoMock(),
  getRuntimeVersions: () => getRuntimeVersionsMock(),
  getNativeBuildNumber: (l?: unknown) => getNativeBuildNumberMock(l as never),
}))

import { VersionBuildCard } from "./version-build-card"

beforeEach(() => {
  getBuildInfoMock.mockReturnValue({ commit: "abc1234", buildTime: "2026-05-30T12:00:00.000Z" })
  getNativeBuildNumberMock.mockResolvedValue(null)
  getRuntimeVersionsMock.mockResolvedValue({
    tauri: "2.9.0",
    react: "19.2.0",
    engine: "Chromium 130.0.0.0",
  })
})

describe("<VersionBuildCard />", () => {
  it("renders version, commit and build time", () => {
    render(<VersionBuildCard />)
    expect(screen.getByTestId("row-version")).toHaveTextContent("9.9.9")
    expect(screen.getByTestId("row-commit")).toHaveTextContent("abc1234")
    expect(screen.getByTestId("row-build-time")).toBeInTheDocument()
  })

  it("hides commit and build-time rows when not injected", () => {
    getBuildInfoMock.mockReturnValue({ commit: "", buildTime: "" })
    render(<VersionBuildCard />)
    expect(screen.queryByTestId("row-commit")).not.toBeInTheDocument()
    expect(screen.queryByTestId("row-build-time")).not.toBeInTheDocument()
  })

  it("shows the native build number when present", async () => {
    getNativeBuildNumberMock.mockResolvedValue("4242")
    render(<VersionBuildCard />)
    await waitFor(() => expect(screen.getByTestId("row-native-build")).toHaveTextContent("4242"))
  })

  it("reveals runtime versions when advanced is expanded", async () => {
    render(<VersionBuildCard />)
    expect(screen.queryByTestId("row-tauri")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("advanced-toggle"))
    await waitFor(() => {
      expect(screen.getByTestId("row-tauri")).toHaveTextContent("2.9.0")
      expect(screen.getByTestId("row-react")).toHaveTextContent("19.2.0")
      expect(screen.getByTestId("row-engine")).toHaveTextContent("Chromium 130.0.0.0")
    })
  })
})
