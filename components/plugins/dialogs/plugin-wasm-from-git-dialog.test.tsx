/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const installFromGitMock = jest.fn()
// Preserve the real GitToolchainMissingError class so `instanceof` checks work.
jest.mock("@/lib/plugin/package/git-installer", () => {
  const actual = jest.requireActual("@/lib/plugin/package/git-installer")
  return {
    ...actual,
    installFromGit: (...args: unknown[]) => installFromGitMock(...args),
  }
})

const requestGrantMock = jest.fn()
jest.mock("@/hooks/plugins/use-wasm-capability-grant", () => ({
  useWasmCapabilityGrant: () => ({
    sheet: null,
    requestGrant: (...args: unknown[]) => requestGrantMock(...args),
  }),
}))

import { PluginWasmFromGitDialog } from "./plugin-wasm-from-git-dialog"
import { GitToolchainMissingError } from "@/lib/plugin/package/git-installer"

const sampleResult = {
  manifest: { id: "demo.wasm", name: "Demo", version: "0.1.0", type: "wasm" },
  path: "/plugins/demo.wasm",
  authorFingerprint: "abcd",
}

beforeEach(() => {
  installFromGitMock.mockReset()
  requestGrantMock.mockReset()
  requestGrantMock.mockResolvedValue({ granted: true })
})

describe("PluginWasmFromGitDialog", () => {
  it("does not render when closed", () => {
    render(<PluginWasmFromGitDialog open={false} onOpenChange={() => {}} />)
    expect(screen.queryByText("title")).not.toBeInTheDocument()
  })

  it("renders repo URL + branch inputs when open", () => {
    render(<PluginWasmFromGitDialog open onOpenChange={() => {}} />)
    expect(screen.getByLabelText("repoUrlLabel")).toBeInTheDocument()
    expect(screen.getByLabelText("branchLabel")).toBeInTheDocument()
  })

  it("shows an empty-URL error and does not install", () => {
    render(<PluginWasmFromGitDialog open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByText("install"))
    expect(screen.getByRole("alert")).toHaveTextContent("emptyError")
    expect(installFromGitMock).not.toHaveBeenCalled()
  })

  it("installs, requests the capability grant, and closes on success", async () => {
    installFromGitMock.mockResolvedValue(sampleResult)
    const onOpenChange = jest.fn()
    const onInstalled = jest.fn()
    render(<PluginWasmFromGitDialog open onOpenChange={onOpenChange} onInstalled={onInstalled} />)
    fireEvent.change(screen.getByLabelText("repoUrlLabel"), {
      target: { value: "https://github.com/owner/repo" },
    })
    fireEvent.change(screen.getByLabelText("branchLabel"), { target: { value: "dev" } })
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => expect(installFromGitMock).toHaveBeenCalled())
    expect(installFromGitMock).toHaveBeenCalledWith({
      repoUrl: "https://github.com/owner/repo",
      branch: "dev",
    })
    await waitFor(() => expect(requestGrantMock).toHaveBeenCalled())
    expect(onInstalled).toHaveBeenCalledWith(sampleResult)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders toolchain-missing help when the build toolchain is absent", async () => {
    installFromGitMock.mockRejectedValue(
      new GitToolchainMissingError("is cargo-component installed")
    )
    render(<PluginWasmFromGitDialog open onOpenChange={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("repoUrlLabel"), {
      target: { value: "https://github.com/owner/repo" },
    })
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => expect(screen.getByText("toolchainMissingTitle")).toBeInTheDocument())
    expect(screen.getByText("toolchainMissingHint")).toBeInTheDocument()
  })

  it("renders a generic error on other failures", async () => {
    installFromGitMock.mockRejectedValue(new Error("clone failed"))
    render(<PluginWasmFromGitDialog open onOpenChange={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("repoUrlLabel"), {
      target: { value: "https://github.com/owner/repo" },
    })
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("clone failed"))
  })

  it("omits branch when left blank", async () => {
    installFromGitMock.mockResolvedValue(sampleResult)
    render(<PluginWasmFromGitDialog open onOpenChange={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("repoUrlLabel"), {
      target: { value: "https://github.com/owner/repo" },
    })
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => expect(installFromGitMock).toHaveBeenCalled())
    expect(installFromGitMock).toHaveBeenCalledWith({
      repoUrl: "https://github.com/owner/repo",
      branch: undefined,
    })
  })
})
