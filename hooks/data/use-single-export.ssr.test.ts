/** @jest-environment node */
import type { ChatSession } from "@cognia/agent-config-types"
import { createElement } from "react"
import { renderToString } from "react-dom/server"

const getDbMock = jest.fn(() => {
  throw new Error("IndexedDB is unavailable during SSR")
})
jest.mock("@/lib/db/schema", () => ({ getDb: () => getDbMock() }))
jest.mock("@/lib/export/single", () => ({ renderSingleExport: jest.fn() }))
jest.mock("@/lib/export/html/theme-wallpaper", () => ({ resolveThemeWallpaper: jest.fn() }))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({ getPluginEventHooks: jest.fn() }))
jest.mock("@/lib/files/save-export", () => ({ saveExport: jest.fn() }))
jest.mock("@/lib/twin/export-provenance", () => ({ resolveSessionTwinProvenance: jest.fn() }))
jest.mock("@/lib/export/disclosure", () => ({ enforceExportDisclosure: jest.fn() }))

jest.mock("next/dynamic", () => () => () => null)
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))

import { ConversationExportDialog } from "@/components/chat/conversation-export-dialog"
import { useSingleExport } from "./use-single-export"

it("server-renders the exporter without opening a browser database", () => {
  function Exporter() {
    const { busy } = useSingleExport()
    return createElement("span", null, String(busy))
  }
  expect(typeof window).toBe("undefined")
  expect(renderToString(createElement(Exporter))).toBe("<span>false</span>")
  expect(getDbMock).not.toHaveBeenCalled()
})

it("server-renders an export dialog with a selected session without opening IndexedDB", () => {
  expect(
    renderToString(
      createElement(ConversationExportDialog, {
        session: { id: "session-1" } as ChatSession,
        onClose: () => {},
      })
    )
  ).toBe("")
  expect(getDbMock).not.toHaveBeenCalled()
})
