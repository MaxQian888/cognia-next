/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import type { PairFailure } from "@ext/src/lib/client"
import { PairScreen } from "./pair-screen"

const api = {
  message: (key: string, subs?: string[]) => (subs ? `${key}:${subs.join(",")}` : key),
} as BrowserApi

describe("PairScreen", () => {
  it("submits the trimmed code", () => {
    const onSubmit = jest.fn()
    render(<PairScreen api={api} busy={false} needsPermission onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText("pairPlaceholder"), {
      target: { value: "  cgnb1|abc  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "pairGrant" }))
    expect(onSubmit).toHaveBeenCalledWith("cgnb1|abc")
  })

  it("will not submit an empty code", () => {
    const onSubmit = jest.fn()
    render(<PairScreen api={api} busy={false} needsPermission onSubmit={onSubmit} />)
    expect(screen.getByRole("button", { name: "pairGrant" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("pairPlaceholder"), { target: { value: "   " } })
    expect(screen.getByRole("button", { name: "pairGrant" })).toBeDisabled()
  })

  it("locks the form while a code is being redeemed", () => {
    // The code is single-use: a second submission spends nothing and reports a
    // failure for a pairing that may already be succeeding.
    render(<PairScreen api={api} busy needsPermission onSubmit={jest.fn()} />)
    expect(screen.getByLabelText("pairPlaceholder")).toBeDisabled()
    expect(screen.getByRole("button", { name: "pairing" })).toBeDisabled()
  })

  it("names the remedy for each way pairing fails", () => {
    // Three of the four are fixed somewhere other than this screen. A single
    // "pairing failed" would send everyone to retype the code.
    const cases: [PairFailure, string][] = [
      [{ code: "wrong_format" }, "pairWrongFormat"],
      [{ code: "version_mismatch", got: 9 }, "pairVersionMismatch"],
      [{ code: "permission_denied" }, "pairPermissionDenied"],
      [
        { code: "invalid", message: "the pairing code has expired" },
        "the pairing code has expired",
      ],
      [{ code: "rejected", message: "bad origin" }, "pairFailed:bad origin"],
    ]
    for (const [failure, expected] of cases) {
      const { unmount } = render(
        <PairScreen api={api} busy={false} needsPermission failure={failure} onSubmit={jest.fn()} />
      )
      expect(screen.getByTestId("pair-failure")).toHaveTextContent(expected)
      unmount()
    }
  })

  it("says Connect, with no warning, once the permission is already held", () => {
    // After the first pairing on a profile the prompt does not appear, and a
    // notice about it would be a warning about something that will not happen.
    render(<PairScreen api={api} busy={false} needsPermission={false} onSubmit={jest.fn()} />)
    expect(screen.getByRole("button", { name: "pairSubmit" })).toBeInTheDocument()
    expect(screen.queryByTestId("pair-permission-notice")).toBeNull()
  })

  it("says what the permission prompt will be for before it appears", () => {
    // Chrome's own dialog names neither who is asking nor what for.
    render(<PairScreen api={api} busy={false} needsPermission onSubmit={jest.fn()} />)
    expect(screen.getByTestId("pair-permission-notice")).toHaveTextContent("pairPermissionNeeded")
  })

  it("shows no failure until there is one", () => {
    render(<PairScreen api={api} busy={false} needsPermission onSubmit={jest.fn()} />)
    expect(screen.queryByTestId("pair-failure")).toBeNull()
  })
})
