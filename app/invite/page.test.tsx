/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key
    t.has = () => true
    return t
  },
}))
const replace = jest.fn()
let search = ""
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
}))

import { PENDING_INVITATION_KEY } from "@/lib/identity/pending-invitation"

import InvitePage from "./page"

const TOKEN = "Qm9uam91ciBsZSBtb25kZSwgamUgc3VpcyB1biB0b2tlbg"

beforeEach(() => {
  sessionStorage.clear()
  replace.mockClear()
})

describe("/invite", () => {
  it("keeps the token for the gate and sends the person to the root", async () => {
    search = `?token=${TOKEN}`
    render(<InvitePage />)
    await waitFor(() =>
      expect(screen.getByTestId("invite-page")).toHaveAttribute("data-state", "kept")
    )
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBe(TOKEN)
    fireEvent.click(screen.getByTestId("invite-continue"))
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("says when the link carries no token", async () => {
    search = "?token=nope"
    render(<InvitePage />)
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid")
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
  })
})
