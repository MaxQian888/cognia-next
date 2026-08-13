import { render, screen } from "@testing-library/react"

import { InboxAssetsTab } from "./inbox-assets-tab"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("./labels-tab", () => ({ LabelsTab: () => <div>labels-body</div> }))
jest.mock("./canned-responses-tab", () => ({ CannedResponsesTab: () => <div>canned-body</div> }))

it("groups Labels and Canned Responses as Inbox assets", () => {
  render(<InboxAssetsTab />)
  expect(screen.getByRole("tab", { name: "labels" })).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "cannedResponses" })).toBeInTheDocument()
})
