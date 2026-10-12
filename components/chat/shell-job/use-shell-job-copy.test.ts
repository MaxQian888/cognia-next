/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}))

import { useShellJobCopy } from "./use-shell-job-copy"

describe("useShellJobCopy", () => {
  it("builds every transcript phrase from the shell job namespace", () => {
    const { result } = renderHook(() => useShellJobCopy())
    const copy = result.current
    const ns = "chat.composer.shell.job"
    expect(copy.header("ls", "exit 0")).toBe(`${ns}.header:{"cmd":"ls","status":"exit 0"}`)
    expect(copy.statusExit(2)).toBe(`${ns}.status.exit:{"code":"2"}`)
    expect(copy.statusKilled).toBe(`${ns}.status.killed`)
    expect(copy.statusInterrupted).toBe(`${ns}.status.interrupted`)
    expect(copy.statusFailed).toBe(`${ns}.status.failed`)
    expect(copy.noOutput).toBe(`${ns}.noOutput`)
    expect(copy.truncated).toBe(`${ns}.truncated`)
    expect(copy.movedToBackground("make")).toBe(`${ns}.movedToBackground:{"cmd":"make"}`)
    expect(copy.lost("make", "gone")).toBe(`${ns}.lost:{"cmd":"make","error":"gone"}`)
  })
})
