/**
 * @jest-environment jsdom
 */

const mockPlugins: Record<string, { manifest: { name: string } }> = {}
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: (select: (state: { plugins: typeof mockPlugins }) => unknown) =>
    select({ plugins: mockPlugins }),
}))

import { renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"

import { useExtensionName } from "./use-extension-name"

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    {children}
  </NextIntlClientProvider>
)

it("prefers the manifest name, then the id, then a generic name", () => {
  mockPlugins["ext.a"] = { manifest: { name: "Acme Tools" } }
  expect(renderHook(() => useExtensionName("ext.a"), { wrapper }).result.current).toBe("Acme Tools")
  expect(renderHook(() => useExtensionName("ext.b"), { wrapper }).result.current).toBe("ext.b")
  expect(renderHook(() => useExtensionName(""), { wrapper }).result.current).toBe(
    "VS Code extension"
  )
})
