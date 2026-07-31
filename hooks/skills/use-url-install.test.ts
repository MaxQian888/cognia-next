/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const parseMock = jest.fn()
const resolveMock = jest.fn()
const installMock = jest.fn()

jest.mock("@/lib/skills/skillssh-github", () => ({
  parseSkillsShInput: (input: string) => parseMock(input),
  resolveSkillsShRef: (ref: unknown) => resolveMock(ref),
}))
jest.mock("@/lib/skills/marketplace-install", () => ({
  installMarketplaceItem: (item: unknown) => installMock(item),
}))

import { URL_INSTALL_INVALID, useUrlInstall } from "./use-url-install"

const ITEM = { id: "skillssh:o/r/s", name: "s" }

beforeEach(() => {
  parseMock.mockReset().mockReturnValue({ kind: "full", owner: "o", repo: "r", slug: "s" })
  resolveMock.mockReset().mockResolvedValue({ item: ITEM, detail: { files: [] } })
  installMock.mockReset().mockResolvedValue({ skill: { id: "x" }, created: true })
})

describe("useUrlInstall", () => {
  it("parses, resolves, installs, and returns the item", async () => {
    const { result } = renderHook(() => useUrlInstall())
    let item: unknown
    await act(async () => {
      item = await result.current.run("https://skills.sh/o/r/s")
    })
    expect(parseMock).toHaveBeenCalledWith("https://skills.sh/o/r/s")
    expect(resolveMock).toHaveBeenCalledWith({ kind: "full", owner: "o", repo: "r", slug: "s" })
    expect(installMock).toHaveBeenCalledWith(ITEM)
    expect(item).toEqual(ITEM)
    expect(result.current.error).toBeNull()
  })

  it("rejects unparseable input with the invalid sentinel without resolving", async () => {
    parseMock.mockReturnValue({ kind: "invalid" })
    const { result } = renderHook(() => useUrlInstall())
    await act(async () => {
      await expect(result.current.run("nope")).rejects.toThrow(URL_INSTALL_INVALID)
    })
    expect(result.current.error).toBe(URL_INSTALL_INVALID)
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it("stringifies non-Error resolver failures", async () => {
    resolveMock.mockRejectedValue("plain-string")
    const { result } = renderHook(() => useUrlInstall())
    await act(async () => {
      await result.current.run("o/r/s").catch(() => undefined)
    })
    expect(result.current.error).toBe("plain-string")
  })

  it("surfaces resolver errors and resets busy", async () => {
    resolveMock.mockRejectedValue(new Error("No skill found at o/r/r"))
    const { result } = renderHook(() => useUrlInstall())
    await act(async () => {
      await expect(result.current.run("o/r")).rejects.toThrow(/No skill found/)
    })
    expect(result.current.error).toContain("No skill found")
    expect(result.current.busy).toBe(false)
  })

  it("busy toggles while resolving and clearError resets", async () => {
    let release: () => void = () => undefined
    resolveMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ item: ITEM, detail: { files: [] } })
        })
    )
    const { result } = renderHook(() => useUrlInstall())
    let p!: Promise<unknown>
    act(() => {
      p = result.current.run("o/r/s")
    })
    await waitFor(() => expect(result.current.busy).toBe(true))
    await act(async () => {
      release()
      await p
    })
    expect(result.current.busy).toBe(false)

    parseMock.mockReturnValue({ kind: "invalid" })
    await act(async () => {
      await result.current.run("bad").catch(() => undefined)
    })
    expect(result.current.error).toBe(URL_INSTALL_INVALID)
    act(() => {
      result.current.clearError()
    })
    expect(result.current.error).toBeNull()
  })
})
