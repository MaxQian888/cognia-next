const invokeMock = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { installFromGit, GitToolchainMissingError } from "./git-installer"

function setTauri(present: boolean) {
  if (present) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => ({}),
    })
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  setTauri(true)
})

describe("installFromGit", () => {
  it("throws in browser mode", async () => {
    setTauri(false)
    await expect(installFromGit({ repoUrl: "https://x/y.git" })).rejects.toThrow(
      /Tauri desktop runtime/
    )
  })

  it("rejects empty repoUrl", async () => {
    await expect(installFromGit({ repoUrl: "   " })).rejects.toThrow(/repoUrl/)
  })

  it("invokes plugin_wasm_install_from_git with branch", async () => {
    invokeMock.mockResolvedValueOnce({
      manifest: { id: "demo.wasm", type: "wasm" },
      path: "/plugins/demo.wasm",
      signatureVerified: false,
    })
    const out = await installFromGit({
      repoUrl: "https://github.com/example/plugin.git",
      branch: "main",
    })
    expect(out.path).toBe("/plugins/demo.wasm")
    expect(invokeMock).toHaveBeenCalledWith("plugin_wasm_install_from_git", {
      repoUrl: "https://github.com/example/plugin.git",
      branch: "main",
    })
  })

  it("wraps git-missing errors in GitToolchainMissingError", async () => {
    invokeMock.mockRejectedValueOnce(new Error("git clone (is git installed?): not found"))
    await expect(
      installFromGit({ repoUrl: "https://github.com/example/plugin.git" })
    ).rejects.toBeInstanceOf(GitToolchainMissingError)
  })

  it("wraps cargo-component errors in GitToolchainMissingError", async () => {
    invokeMock.mockRejectedValueOnce(
      new Error(
        "cargo component build failed (is cargo-component installed? run `cargo install cargo-component`): not found"
      )
    )
    await expect(
      installFromGit({ repoUrl: "https://github.com/example/plugin.git" })
    ).rejects.toBeInstanceOf(GitToolchainMissingError)
  })

  it("passes through other errors unwrapped", async () => {
    invokeMock.mockRejectedValueOnce(new Error("repository is missing plugin.json"))
    await expect(
      installFromGit({ repoUrl: "https://github.com/example/plugin.git" })
    ).rejects.not.toBeInstanceOf(GitToolchainMissingError)
  })
})
