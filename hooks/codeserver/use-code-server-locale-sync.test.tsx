import { renderHook, waitFor } from "@testing-library/react"

let mockIsTauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    readRuntimeArgs: jest.fn(),
    writeRuntimeArgs: jest.fn(),
    languagePackAvailable: jest.fn(),
  },
}))

const settingsState = { language: "zh-CN" as string }
jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

import { codeServerClient } from "@/lib/codeserver/client"
import { useCodeServerLocaleSync } from "./use-code-server-locale-sync"

const client = codeServerClient as jest.Mocked<typeof codeServerClient>
const written = () => JSON.parse(client.writeRuntimeArgs.mock.calls.at(-1)![0] as string)

let restart: jest.Mock
let onUntranslated: jest.Mock

beforeEach(() => {
  mockIsTauri = true
  settingsState.language = "zh-CN"
  restart = jest.fn()
  onUntranslated = jest.fn()
  client.readRuntimeArgs.mockReset().mockResolvedValue("")
  client.writeRuntimeArgs.mockReset().mockResolvedValue(undefined)
  client.languagePackAvailable.mockReset().mockResolvedValue(true)
})

it("writes the app language into argv.json and restarts the workbench", async () => {
  renderHook(() => useCodeServerLocaleSync(true, { restart }))

  await waitFor(() => expect(client.writeRuntimeArgs).toHaveBeenCalled())
  expect(written().locale).toBe("zh-cn")
  // VS Code reads argv.json only at startup, so the write alone would be a no-op.
  await waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
})

it("does nothing when the locale is already correct", async () => {
  // Otherwise every mount would restart the editor and throw away the user's open
  // tabs and terminals to re-apply a locale that was already right.
  client.readRuntimeArgs.mockResolvedValue('{"locale":"zh-cn"}')
  renderHook(() => useCodeServerLocaleSync(true, { restart }))

  await waitFor(() => expect(client.readRuntimeArgs).toHaveBeenCalled())
  expect(client.writeRuntimeArgs).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
})

it("rewrites and restarts when the app language changes", async () => {
  client.readRuntimeArgs.mockResolvedValue('{"locale":"zh-cn"}')
  const { rerender } = renderHook(() => useCodeServerLocaleSync(true, { restart }))
  await waitFor(() => expect(client.readRuntimeArgs).toHaveBeenCalled())

  settingsState.language = "en"
  rerender()

  await waitFor(() => expect(written().locale).toBe("en"))
  await waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
})

it("preserves the other runtime arguments in the file", async () => {
  client.readRuntimeArgs.mockResolvedValue(
    JSON.stringify({ "enable-crash-reporter": false, locale: "en" })
  )
  renderHook(() => useCodeServerLocaleSync(true, { restart }))

  await waitFor(() => expect(client.writeRuntimeArgs).toHaveBeenCalled())
  expect(written()).toEqual({ "enable-crash-reporter": false, locale: "zh-cn" })
})

it("treats an unreadable argv.json as empty rather than skipping the sync", async () => {
  client.readRuntimeArgs.mockRejectedValue(new Error("no app data dir"))
  renderHook(() => useCodeServerLocaleSync(true, { restart }))

  await waitFor(() => expect(client.writeRuntimeArgs).toHaveBeenCalled())
  expect(written().locale).toBe("zh-cn")
})

it("does not restart when the write failed", async () => {
  // Restarting would cost the user their session for a change that did not land.
  client.writeRuntimeArgs.mockRejectedValue(new Error("read-only fs"))
  renderHook(() => useCodeServerLocaleSync(true, { restart }))

  await waitFor(() => expect(client.writeRuntimeArgs).toHaveBeenCalled())
  expect(restart).not.toHaveBeenCalled()
})

it("does nothing while disabled", async () => {
  renderHook(() => useCodeServerLocaleSync(false, { restart }))
  await waitFor(() => expect(client.readRuntimeArgs).not.toHaveBeenCalled())
})

it("does nothing outside the desktop shell", async () => {
  mockIsTauri = false
  renderHook(() => useCodeServerLocaleSync(true, { restart }))
  await waitFor(() => expect(client.readRuntimeArgs).not.toHaveBeenCalled())
})

it("does not restart just because the restart callback identity changed", async () => {
  client.readRuntimeArgs.mockResolvedValue('{"locale":"zh-cn"}')
  const { rerender } = renderHook(
    ({ cb }: { cb: () => void }) => useCodeServerLocaleSync(true, { restart: cb }),
    { initialProps: { cb: restart } }
  )
  await waitFor(() => expect(client.readRuntimeArgs).toHaveBeenCalled())

  rerender({ cb: jest.fn() })
  rerender({ cb: jest.fn() })

  expect(client.writeRuntimeArgs).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
})

describe("languages VS Code cannot translate", () => {
  it("reports it instead of restarting into the same English", async () => {
    // Restarting costs the user their open tabs and terminals; spending that on a
    // locale the workbench has no pack for reads as the sync being broken.
    client.languagePackAvailable.mockResolvedValue(false)
    renderHook(() => useCodeServerLocaleSync(true, { restart, onUntranslated }))

    await waitFor(() => expect(onUntranslated).toHaveBeenCalledWith("zh-cn"))
    // The locale is still written, so a pack installed later takes effect.
    expect(client.writeRuntimeArgs).toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it("never probes for English, which needs no pack at all", async () => {
    settingsState.language = "en"
    client.readRuntimeArgs.mockResolvedValue('{"locale":"ja"}')
    renderHook(() => useCodeServerLocaleSync(true, { restart, onUntranslated }))

    await waitFor(() => expect(restart).toHaveBeenCalled())
    expect(client.languagePackAvailable).not.toHaveBeenCalled()
    expect(onUntranslated).not.toHaveBeenCalled()
  })

  it("restarts anyway when the availability probe itself fails", async () => {
    // A failed probe is not evidence the language is untranslatable; the pack
    // install is best-effort on the Rust side either way.
    client.languagePackAvailable.mockRejectedValue(new Error("desktop only"))
    renderHook(() => useCodeServerLocaleSync(true, { restart, onUntranslated }))

    await waitFor(() => expect(restart).toHaveBeenCalled())
    expect(onUntranslated).not.toHaveBeenCalled()
  })

  it("still restarts without an onUntranslated handler when a pack exists", async () => {
    renderHook(() => useCodeServerLocaleSync(true, { restart }))
    await waitFor(() => expect(restart).toHaveBeenCalled())
  })
})

describe("trust-domain profile", () => {
  it("reads and writes argv.json in the managed profile by default", async () => {
    renderHook(() => useCodeServerLocaleSync(true, { restart }))

    await waitFor(() => expect(client.writeRuntimeArgs).toHaveBeenCalled())
    expect(client.readRuntimeArgs).toHaveBeenCalledWith("managed")
    expect(client.writeRuntimeArgs.mock.calls.at(-1)![1]).toBe("managed")
  })

  it("follows the pane into the native profile", async () => {
    renderHook(() => useCodeServerLocaleSync(true, { restart }, "native"))

    await waitFor(() => expect(client.writeRuntimeArgs).toHaveBeenCalled())
    expect(client.readRuntimeArgs).toHaveBeenCalledWith("native")
    expect(client.writeRuntimeArgs.mock.calls.at(-1)![1]).toBe("native")
  })
})
