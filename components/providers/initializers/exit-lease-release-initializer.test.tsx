import { render } from "@testing-library/react"

import { ExitLeaseReleaseInitializer } from "./exit-lease-release-initializer"

const dispose = jest.fn()
const installExitLeaseRelease = jest.fn(() => dispose)

jest.mock("@/lib/workflow/runtime/exit-lease-release", () => ({
  installExitLeaseRelease: () => installExitLeaseRelease(),
}))

describe("ExitLeaseReleaseInitializer", () => {
  beforeEach(() => jest.clearAllMocks())

  it("subscribes once and detaches on unmount", () => {
    const { rerender, unmount } = render(<ExitLeaseReleaseInitializer />)
    rerender(<ExitLeaseReleaseInitializer />)

    expect(installExitLeaseRelease).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()

    unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
