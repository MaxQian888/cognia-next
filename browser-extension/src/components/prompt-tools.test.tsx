/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { STORAGE_KEYS, type BrowserApi } from "@ext/src/lib/browser-api"

import { PromptTools } from "./prompt-tools"

function fakeApi(stored: unknown = []) {
  const store = new Map<string, unknown>([[STORAGE_KEYS.savedPrompts, stored]])
  const listeners = new Set<(value: unknown) => void>()
  const api = {
    message: (key: string) => key,
    read: async (key: string) => store.get(key) ?? null,
    write: async (key: string, value: unknown) => {
      store.set(key, value)
    },
    onStorageChange: (_key: string, listener: (value: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as BrowserApi
  return { api, store, listeners }
}

describe("PromptTools", () => {
  it("fills the instruction from a quick action, naming it", async () => {
    const { api } = fakeApi()
    const onUse = jest.fn()
    render(<PromptTools api={api} instruction="" onUse={onUse} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByTestId("quick-action-translate"))
    expect(onUse).toHaveBeenCalledWith("quickPromptTranslate", "translate")
  })

  it("inserts, saves, edits and deletes saved prompts", async () => {
    const { api, store } = fakeApi([{ id: "p1", title: "Brief", instruction: "Be brief" }])
    const onUse = jest.fn()
    render(<PromptTools api={api} instruction="Compare prices" onUse={onUse} />)
    fireEvent.click(await screen.findByTestId("saved-prompt-p1"))
    expect(onUse).toHaveBeenCalledWith("Be brief")

    fireEvent.click(screen.getByTestId("prompts-manage"))
    fireEvent.click(screen.getByTestId("prompts-save-current"))
    await waitFor(() =>
      expect(store.get(STORAGE_KEYS.savedPrompts)).toEqual([
        { id: "p1", title: "Brief", instruction: "Be brief" },
        expect.objectContaining({ title: "Compare prices", instruction: "Compare prices" }),
      ])
    )

    fireEvent.click(screen.getByTestId("prompt-edit-p1"))
    fireEvent.change(screen.getByTestId("prompt-edit-title"), { target: { value: "Short" } })
    fireEvent.click(screen.getByTestId("prompt-edit-save"))
    await waitFor(() =>
      expect((store.get(STORAGE_KEYS.savedPrompts) as { title: string }[])[0]?.title).toBe("Short")
    )

    fireEvent.click(screen.getByTestId("prompt-delete-p1"))
    await waitFor(() => expect(store.get(STORAGE_KEYS.savedPrompts)).toHaveLength(1))
  })

  it("says why an edit cannot be saved", async () => {
    const { api } = fakeApi([{ id: "p1", title: "Brief", instruction: "Be brief" }])
    render(<PromptTools api={api} instruction="" onUse={jest.fn()} />)
    fireEvent.click(screen.getByTestId("prompts-manage"))
    expect(screen.getByTestId("prompts-save-current")).toBeDisabled()
    fireEvent.click(await screen.findByTestId("prompt-edit-p1"))
    fireEvent.change(screen.getByTestId("prompt-edit-instruction"), { target: { value: "  " } })
    fireEvent.click(screen.getByTestId("prompt-edit-save"))
    expect(await screen.findByTestId("prompts-error")).toHaveTextContent("promptsEmpty")
  })

  it("follows changes made in another panel", async () => {
    const { api, listeners } = fakeApi([])
    render(<PromptTools api={api} instruction="" onUse={jest.fn()} />)
    await act(async () => undefined)
    await act(async () => {
      for (const listener of listeners)
        listener([{ id: "p9", title: "Elsewhere", instruction: "x" }])
    })
    expect(screen.getByTestId("saved-prompt-p9")).toHaveTextContent("Elsewhere")
  })
})
