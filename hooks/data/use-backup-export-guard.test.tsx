import { renderHook } from "@testing-library/react"
import { useBackupExportGuard } from "./use-backup-export-guard"

let mockRequired = false
let mockBlocked: string | null = null
const mockGuard = jest.fn()
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ settings: { biometricRequiredFor: { exportBackup: mockRequired } } }),
}))
jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard: () => async (gate: unknown, action: () => Promise<unknown>) => {
    mockGuard(gate)
    return mockBlocked
      ? { kind: "blocked", reason: mockBlocked }
      : { kind: "ok", value: await action() }
  },
}))

beforeEach(() => {
  mockRequired = false
  mockBlocked = null
  mockGuard.mockClear()
})

it("runs an export without a native prompt when its policy is off", async () => {
  const { result } = renderHook(() => useBackupExportGuard())
  const exportBackup = jest.fn(async () => "saved")
  await expect(result.current(exportBackup)).resolves.toEqual({ kind: "ok", value: "saved" })
  expect(mockGuard).not.toHaveBeenCalled()
})

it.each(["cancelled", "lockout", "error"])(
  "does not run the export for a required %s outcome",
  async (reason) => {
    mockRequired = true
    mockBlocked = reason
    const { result } = renderHook(() => useBackupExportGuard())
    const exportBackup = jest.fn(async () => "saved")
    await expect(result.current(exportBackup)).resolves.toEqual({ kind: "blocked", reason })
    expect(exportBackup).not.toHaveBeenCalled()
  }
)

it("authenticates the export while preserving the explicit no-enrollment recovery policy", async () => {
  mockRequired = true
  const { result } = renderHook(() => useBackupExportGuard())
  const exportBackup = jest.fn(async () => "saved")
  await expect(result.current(exportBackup)).resolves.toEqual({ kind: "ok", value: "saved" })
  expect(exportBackup).toHaveBeenCalledTimes(1)
  expect(mockGuard).toHaveBeenCalledWith(
    expect.objectContaining({ fallthroughWhenUnavailable: true })
  )
})
