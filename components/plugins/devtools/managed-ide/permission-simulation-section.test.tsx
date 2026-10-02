/**
 * @jest-environment jsdom
 */

const mockSetSimulated = jest.fn()
jest.mock("@/lib/plugin/ide/dev-mode", () => ({
  setSimulatedPermission: (...args: unknown[]) => mockSetSimulated(...args),
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { Plugin } from "@/types/plugin"

import {
  PermissionSimulationSection,
  simulatablePermissions,
} from "./permission-simulation-section"

const plugin = (id: string, ide = true) =>
  ({
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      type: "frontend",
      permissions: ["process:spawn"],
      ...(ide
        ? {
            ide: {
              schemaVersion: 1,
              targets: ["pro-ide"],
              providers: [{ id: "hover", kind: "hover", handler: "provideHover" }],
            },
          }
        : {}),
    },
  }) as unknown as Plugin

function renderSection(plugins: Plugin[], simulations = []) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PermissionSimulationSection plugins={plugins} simulations={simulations} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => mockSetSimulated.mockClear())

it("offers what a plugin declares and what its providers need", () => {
  expect(simulatablePermissions(plugin("acme"))).toEqual(["editor:read", "process:spawn"])
})

it("says when no plugin targets the Pro IDE", () => {
  renderSection([plugin("plain", false)])
  expect(screen.getByTestId("managed-ide-simulation-none")).toBeInTheDocument()
})

it("lists the simulations in force, each marked, and stops one", async () => {
  renderSection([plugin("acme")], [
    { pluginId: "acme", permission: "process:spawn", decision: "deny" },
  ] as never)
  const entry = screen.getByTestId("managed-ide-simulation-acme-process:spawn")
  expect(entry).toHaveTextContent("Simulated")
  expect(entry).toHaveTextContent("Deny")
  await userEvent.click(
    screen.getByRole("button", { name: "Stop simulating process:spawn for acme" })
  )
  expect(mockSetSimulated).toHaveBeenCalledWith("acme", "process:spawn", null)
})

it("cannot simulate before a plugin and a permission are chosen", () => {
  renderSection([plugin("acme")])
  expect(screen.getByRole("button", { name: "Simulate" })).toBeDisabled()
  expect(screen.getByText("No permission is simulated.")).toBeInTheDocument()
})
