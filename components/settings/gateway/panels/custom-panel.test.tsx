/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GATEWAY_CONFIG } from "@/types/gateway"

import { GatewayCustomPanel } from "./custom-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
  CodeBlockActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockCopyButton: () => null,
  CodeBlockFilename: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  CodeBlockHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

it("applies a complete validated GatewayConfig through the replacement seam", async () => {
  const user = userEvent.setup()
  const replace = jest.fn().mockResolvedValue(undefined)
  render(
    <GatewayCustomPanel
      ctx={{
        config: DEFAULT_GATEWAY_CONFIG,
        status: null,
        persist: jest.fn(),
        replace,
        restartRequired: false,
      }}
    />
  )

  const editor = screen.getByLabelText("editorLabel")
  const parsed = JSON.parse((editor as HTMLTextAreaElement).value)
  fireEvent.change(editor, {
    target: {
      value: JSON.stringify({ ...parsed, retryBackoffBaseMs: 800, respectRetryAfter: false }),
    },
  })
  await user.click(screen.getByRole("button", { name: "apply" }))

  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({ retryBackoffBaseMs: 800, respectRetryAfter: false })
    )
  )
})

it("surfaces the listener restart requirement beside custom configuration", () => {
  render(
    <GatewayCustomPanel
      ctx={{
        config: DEFAULT_GATEWAY_CONFIG,
        status: null,
        persist: jest.fn(),
        replace: jest.fn(),
        restartRequired: true,
      }}
    />
  )

  expect(screen.getByText("restartRequiredBadge")).toBeInTheDocument()
})
