/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"

let mockEnabled = true
jest.mock("@/lib/templates/feature-flags", () => ({
  isUnifiedTemplatePlatformEnabled: () => mockEnabled,
}))

import { createDocumentTemplate } from "@/lib/db/document-templates"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { useDocumentTemplates } from "./use-document-templates"

beforeEach(async () => {
  mockEnabled = true
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

it("lists the localized built-ins, then saved templates, live", async () => {
  const { result } = renderHook(() => useDocumentTemplates())
  await waitFor(() => expect(result.current.options).toHaveLength(5))
  expect(result.current.enabled).toBe(true)
  const meeting = result.current.options!.find((option) => option.id === "meeting-notes")!
  expect(meeting).toMatchObject({ name: "Meeting notes", source: "builtin", icon: "meeting" })
  expect(meeting.content).toContain("## Action items")

  await createDocumentTemplate({
    name: "Postmortem",
    content: "# P",
    language: "markdown",
    type: "text",
  })
  await waitFor(() => expect(result.current.options).toHaveLength(6))
  expect(result.current.options![5]).toMatchObject({ name: "Postmortem", source: "user" })
})

it("offers nothing while the template platform is off", async () => {
  mockEnabled = false
  const { result } = renderHook(() => useDocumentTemplates())
  expect(result.current).toEqual({ enabled: false, options: [] })
})
