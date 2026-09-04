import { render, screen } from "@testing-library/react"
import { ImportSummary } from "./import-summary"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (values?.count !== undefined) return `${key}:${values.count}`
    if (!values) return key
    return `${key}(${Object.entries(values)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(",")})`
  },
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

it("says the pet was NOT replaced when the backup held a different one", () => {
  // A silent skip would read as "your pet was restored" when it was not.
  render(
    <ImportSummary
      summary={{
        added: {},
        overwritten: {},
        skipped: { petProfile: 1 },
        builtInsSkipped: {},
        petProfileConflict: {
          localName: "Pip",
          localLevel: 3,
          incomingName: "Boba",
          incomingLevel: 40,
        },
      }}
    />
  )
  expect(screen.getByText(/summaryPetConflict:/)).toBeInTheDocument()
  expect(screen.getByText(/incomingName=Boba/)).toBeInTheDocument()
  expect(screen.getByText(/localName=Pip/)).toBeInTheDocument()
})

it("names an unhatched pet rather than rendering a blank", () => {
  render(
    <ImportSummary
      summary={{
        added: {},
        overwritten: {},
        skipped: {},
        builtInsSkipped: {},
        petProfileConflict: {
          localName: null,
          localLevel: 1,
          incomingName: "Boba",
          incomingLevel: 9,
        },
      }}
    />
  )
  expect(screen.getByText(/localName=summaryPetUnnamed/)).toBeInTheDocument()
})

it("shows nothing about the pet when there was no collision", () => {
  render(
    <ImportSummary summary={{ added: {}, overwritten: {}, skipped: {}, builtInsSkipped: {} }} />
  )
  expect(screen.queryByText(/summaryPetConflict/)).not.toBeInTheDocument()
})
