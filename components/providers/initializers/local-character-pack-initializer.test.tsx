import { render, waitFor } from "@testing-library/react"
import { toast } from "sonner"

import { LocalCharacterPackInitializer } from "./local-character-pack-initializer"
import { scanAndRegisterLocalPacks } from "@/lib/plugin/character-pack/local-pack-store"

jest.mock("@/lib/plugin/character-pack/local-pack-store", () => ({
  scanAndRegisterLocalPacks: jest.fn(),
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn() },
}))

jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { warn: jest.fn() } },
}))

const mockScan = scanAndRegisterLocalPacks as jest.MockedFunction<typeof scanAndRegisterLocalPacks>

describe("LocalCharacterPackInitializer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("reports signature failures separately from ordinary skipped packs", async () => {
    mockScan.mockResolvedValue({
      registered: [],
      skipped: [
        { filename: "tampered", reason: "signature" },
        { filename: "invalid", reason: "schema" },
      ],
      signatureSkipped: 1,
    })

    render(<LocalCharacterPackInitializer />)

    await waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1))
    expect(toast.error).toHaveBeenCalledWith("1 signed pack failed verification and was not loaded")
    expect(toast.warning).toHaveBeenCalledWith("Skipped 1 local pack file(s) — see logs")
  })

  it("reports only the ordinary skipped-pack count when signatures are valid", async () => {
    mockScan.mockResolvedValue({
      registered: [],
      skipped: [
        { filename: "invalid-a", reason: "schema" },
        { filename: "invalid-b", reason: "schema" },
      ],
      signatureSkipped: 0,
    })

    render(<LocalCharacterPackInitializer />)

    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith("Skipped 2 local pack file(s) — see logs")
  })

  it("logs scan failures without throwing into the layout", async () => {
    mockScan.mockRejectedValue(new Error("scan failed"))
    const { loggers } = jest.requireMock("@cognia/logging") as {
      loggers: { plugin: { warn: jest.Mock } }
    }

    render(<LocalCharacterPackInitializer />)

    await waitFor(() =>
      expect(loggers.plugin.warn).toHaveBeenCalledWith(
        "local-pack-store: boot scan threw",
        expect.objectContaining({ err: expect.any(Error) })
      )
    )
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it("does not scan again when rerendered", async () => {
    mockScan.mockResolvedValue({ registered: [], skipped: [], signatureSkipped: 0 })

    const { rerender } = render(<LocalCharacterPackInitializer />)
    await waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1))
    rerender(<LocalCharacterPackInitializer />)

    expect(mockScan).toHaveBeenCalledTimes(1)
  })
})
