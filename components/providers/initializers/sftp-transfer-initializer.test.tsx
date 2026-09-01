import { render } from "@testing-library/react"

import { SftpTransferInitializer } from "./sftp-transfer-initializer"

const startSftpTransferPump = jest.fn()
const isTauri = jest.fn(() => true)
let unlockedAccountId: string | null = "acct-1"

jest.mock("@/lib/sftp/transfer-queue", () => ({
  startSftpTransferPump: (...args: unknown[]) => startSftpTransferPump(...args),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId }),
}))

beforeEach(() => {
  startSftpTransferPump.mockReset().mockReturnValue(jest.fn())
  isTauri.mockReturnValue(true)
  unlockedAccountId = "acct-1"
})

describe("SftpTransferInitializer", () => {
  /**
   * Before an account is unlocked there is no database to read a queued row
   * out of, so starting the poll early is a loop that finds nothing.
   */
  it("waits for an unlocked account", () => {
    unlockedAccountId = null
    render(<SftpTransferInitializer />)
    expect(startSftpTransferPump).not.toHaveBeenCalled()
  })

  /**
   * The desktop is the host, so its own transfers need no approval from
   * anyone. Requiring one there would park every transfer behind a prompt with
   * nobody on the other side of it.
   */
  it("asks for no approval on the desktop and for one everywhere else", () => {
    render(<SftpTransferInitializer />)
    expect(startSftpTransferPump).toHaveBeenCalledWith({ requiresApproval: false })

    startSftpTransferPump.mockClear()
    isTauri.mockReturnValue(false)
    render(<SftpTransferInitializer />)
    expect(startSftpTransferPump).toHaveBeenCalledWith({ requiresApproval: true })
  })

  it("stops the pump when it unmounts", () => {
    const stop = jest.fn()
    startSftpTransferPump.mockReturnValue(stop)
    const view = render(<SftpTransferInitializer />)
    view.unmount()
    expect(stop).toHaveBeenCalled()
  })
})
