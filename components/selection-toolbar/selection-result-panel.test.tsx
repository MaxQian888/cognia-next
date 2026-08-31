/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import { createRef } from "react"
import { SelectionResultPanel, SelectionResultPanelShell } from "./selection-result-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars?.name ? `${key}:${vars.name}` : key,
}))

const candidate = {
  id: "candidate-1",
  text: "Original text",
  sourceApp: "TextEdit",
  origin: "accessibility" as const,
  capturedAt: 1,
  truncated: false,
  editable: true,
  replaceCapability: "paste" as const,
}

it("shows comparison, attribution, source warning, and preview-first actions", () => {
  const onCopy = jest.fn()
  const onReplace = jest.fn()
  const onOpen = jest.fn()
  const onCancel = jest.fn()
  render(
    <SelectionResultPanel
      candidate={candidate}
      result={{ kind: "text", text: "Improved text" }}
      attribution="Example plugin"
      canReplace
      onCopy={onCopy}
      onOpen={onOpen}
      onReplace={onReplace}
      onCancel={onCancel}
      onUndo={jest.fn()}
    />
  )

  expect(screen.getByText("Original text")).toBeInTheDocument()
  expect(screen.getByText("Improved text")).toBeInTheDocument()
  expect(screen.getByText("attribution:Example plugin")).toBeInTheDocument()
  expect(screen.getByText("source:TextEdit")).toBeInTheDocument()
  expect(screen.getByText("sourceWarning.accessibility")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "copyResult" }))
  fireEvent.click(screen.getByRole("button", { name: "replace" }))
  fireEvent.click(screen.getByRole("button", { name: "openInCognia" }))
  fireEvent.click(screen.getByRole("button", { name: "cancel" }))
  expect(onCopy).toHaveBeenCalledWith("Improved text")
  expect(onReplace).toHaveBeenCalledWith("Improved text")
  expect(onOpen).toHaveBeenCalledWith("Improved text")
  expect(onCancel).toHaveBeenCalled()
})

it("lets the user choose variants and degrades replacement explicitly", () => {
  const onCopy = jest.fn()
  render(
    <SelectionResultPanel
      candidate={{ ...candidate, origin: "ocr", editable: false, replaceCapability: "none" }}
      result={{ kind: "variants", variants: ["First", "Second"] }}
      attribution="Cognia"
      canReplace={false}
      replaceUnavailableReason="replaceUnavailable.ocr"
      onCopy={onCopy}
      onOpen={jest.fn()}
      onReplace={jest.fn()}
      onCancel={jest.fn()}
      onUndo={jest.fn()}
    />
  )

  fireEvent.click(screen.getByRole("button", { name: "Second" }))
  fireEvent.click(screen.getByRole("button", { name: "copyResult" }))
  expect(onCopy).toHaveBeenCalledWith("Second")
  expect(screen.queryByRole("button", { name: "replace" })).not.toBeInTheDocument()
  expect(screen.getByText("replaceUnavailable.ocr")).toBeInTheDocument()
})

it("exposes undo only while a native lease is active", () => {
  const onUndo = jest.fn()
  const { rerender } = render(
    <SelectionResultPanel
      candidate={candidate}
      result={{ kind: "text", text: "Improved" }}
      attribution="Cognia"
      canReplace={false}
      onCopy={jest.fn()}
      onOpen={jest.fn()}
      onReplace={jest.fn()}
      onCancel={jest.fn()}
      onUndo={onUndo}
    />
  )
  expect(screen.queryByRole("button", { name: "undo" })).not.toBeInTheDocument()

  rerender(
    <SelectionResultPanel
      candidate={candidate}
      result={{ kind: "text", text: "Improved" }}
      attribution="Cognia"
      canReplace={false}
      undoAvailable
      onCopy={jest.fn()}
      onOpen={jest.fn()}
      onReplace={jest.fn()}
      onCancel={jest.fn()}
      onUndo={onUndo}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "undo" }))
  expect(onUndo).toHaveBeenCalled()
})

it("keeps host failures visible without discarding the generated result", () => {
  render(
    <SelectionResultPanel
      candidate={candidate}
      result={{ kind: "text", text: "Improved" }}
      attribution="Cognia"
      canReplace={false}
      errorMessage="Copy failed"
      onCopy={jest.fn()}
      onOpen={jest.fn()}
      onReplace={jest.fn()}
      onCancel={jest.fn()}
      onUndo={jest.fn()}
    />
  )
  expect(screen.getByRole("alert")).toHaveTextContent("Copy failed")
  expect(screen.getByText("Improved")).toBeInTheDocument()
})

it("attaches the result to the content-hugging geometry refs", () => {
  const shellRef = createRef<HTMLDivElement>()
  const capsuleRef = createRef<HTMLDivElement>()
  render(
    <SelectionResultPanelShell
      geometry={{
        shellRef,
        capsuleRef,
        panelRef: createRef<HTMLElement>(),
        ghostRef: createRef<HTMLDivElement>(),
        placement: "above",
        measured: true,
        remeasure: jest.fn(),
      }}
    >
      <span>result content</span>
    </SelectionResultPanelShell>
  )
  expect(shellRef.current).toContainElement(capsuleRef.current)
})
