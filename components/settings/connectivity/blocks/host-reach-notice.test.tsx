import { render, screen } from "@testing-library/react"

import en from "@/i18n/messages/en/settings/connectivity.json"
import { HOST_ADMIN_BLOCKS } from "@/lib/connectivity/host-admin-reach"

import { HostReachNotice } from "./host-reach-notice"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const [group, id] = key.split(".") as ["reach" | "reachNext", string]
    return (en as unknown as Record<string, Record<string, string>>)[group][id]
  },
}))

describe("HostReachNotice", () => {
  it.each(HOST_ADMIN_BLOCKS)("explains %s with a reason and a next step", (block) => {
    render(<HostReachNotice block={block} testid="notice" />)
    const notice = screen.getByTestId("notice")
    expect(notice).toHaveAttribute("data-reach", block)
    expect(notice).toHaveTextContent(en.reach[block])
    expect(notice).toHaveTextContent(en.reachNext[block])
  })
})
