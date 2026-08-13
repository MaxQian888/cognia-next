import { render, screen } from "@testing-library/react"
import { ImportSummary } from "./import-summary"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    values?.count === undefined ? key : `${key}:${values.count}`,
}))

it("reports the profile ids whose portable retrieval keys were restored", () => {
  render(
    <ImportSummary
      summary={{
        added: {},
        overwritten: {},
        skipped: {},
        builtInsSkipped: {},
        restoredRetrievalKeyProfiles: ["chat-shared", "memory-shared"],
      }}
    />
  )

  expect(screen.getByText(/summaryRetrievalKeys:2/)).toBeInTheDocument()
  expect(screen.getByText(/chat-shared, memory-shared/)).toBeInTheDocument()
})
