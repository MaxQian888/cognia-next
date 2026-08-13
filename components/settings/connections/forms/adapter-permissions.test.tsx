import { render, screen } from "@testing-library/react"

import { AdapterPermissions } from "./adapter-permissions"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => undefined }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/adapter-instances", () => ({ updateAdapterConfigSection: jest.fn() }))

it("keeps Skills, Host Capabilities, and HITL as distinct permission groups", () => {
  render(<AdapterPermissions adapterId="a" />)
  expect(screen.getByText("builtInSkills")).toBeInTheDocument()
  expect(screen.getByText("hostCapabilities")).toBeInTheDocument()
  expect(screen.getByText("hitl")).toBeInTheDocument()
})
