/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/app-version", () => ({
  APP_VERSION: "9.9.9",
}))

import { VersionRow } from "./version-row"

describe("<VersionRow />", () => {
  it("renders APP_VERSION when the native loader returns null (web / Tauri)", async () => {
    render(<VersionRow loader={async () => null} />)
    await waitFor(() => {
      expect(screen.getByTestId("me-version-row")).toHaveTextContent("9.9.9")
    })
  })

  it("appends the native build number when present (Capacitor)", async () => {
    render(<VersionRow loader={async () => "4242"} />)
    await waitFor(() => {
      expect(screen.getByTestId("me-version-row")).toHaveTextContent("9.9.9 (4242)")
    })
  })

  it("renders the InfoIcon label", () => {
    render(<VersionRow loader={async () => null} />)
    expect(screen.getByTestId("me-version-row")).toHaveTextContent("Version")
  })

  it("tolerates a rejected loader (renders APP_VERSION only)", async () => {
    render(
      <VersionRow
        loader={async () => {
          throw new Error("import failed")
        }}
      />
    )
    // The handler returns the rejected promise, so the catch in
    // loadNativeBuild swallows it and leaves nativeBuild as null.
    await waitFor(() => {
      expect(screen.getByTestId("me-version-row")).toHaveTextContent("9.9.9")
    })
  })
})
