/**
 * @jest-environment jsdom
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { act, renderHook } from "@testing-library/react"

import { useSettingDraft, type SettingDraftOptions } from "./use-setting-draft"

function key(init: {
  key: string
  isComposing?: boolean
  keyCode?: number
}): ReactKeyboardEvent<HTMLElement> & { preventDefault: jest.Mock } {
  return {
    key: init.key,
    keyCode: init.keyCode,
    nativeEvent: { isComposing: init.isComposing ?? false, keyCode: init.keyCode },
    preventDefault: jest.fn(),
  } as unknown as ReactKeyboardEvent<HTMLElement> & { preventDefault: jest.Mock }
}

/** A save whose promise the test resolves, to observe the in-flight window. */
function deferredSave<T>() {
  const resolvers: (() => void)[] = []
  const save = jest.fn(
    (_next: T) =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve)
      })
  )
  return {
    save,
    async land(index = 0) {
      await act(async () => {
        resolvers[index]?.()
        await Promise.resolve()
      })
    },
  }
}

function setup<T extends string | number>(
  persisted: T,
  save: (next: T) => unknown,
  options?: SettingDraftOptions<T>
) {
  return renderHook(({ value }: { value: T }) => useSettingDraft<T>(value, save, options), {
    initialProps: { value: persisted },
  })
}

describe("useSettingDraft", () => {
  it("holds keystrokes locally and writes once, on commit", async () => {
    const save = jest.fn()
    const { result } = setup<string>("", save)

    act(() => result.current.set("c"))
    act(() => result.current.set("cl"))
    act(() => result.current.set("claude"))
    expect(result.current.value).toBe("claude")
    expect(save).not.toHaveBeenCalled()

    await act(async () => result.current.commit())
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith("claude")
  })

  it("writes the normalized value and skips one equal to the persisted value", async () => {
    const save = jest.fn()
    const { result } = setup<string>("claude", save, { normalize: (v) => v.trim() })

    act(() => result.current.set("  claude "))
    await act(async () => result.current.commit())
    expect(save).not.toHaveBeenCalled()
    // The draft is dropped, so the field shows the persisted value again.
    expect(result.current.value).toBe("claude")

    act(() => result.current.set(" opus "))
    await act(async () => result.current.commit())
    expect(save).toHaveBeenCalledWith("opus")
  })

  it("reverts the field when normalize rejects the draft", async () => {
    const save = jest.fn()
    const { result } = setup<string>("45", save, {
      normalize: (v) => (Number.isFinite(Number.parseFloat(v)) ? v : null),
    })

    act(() => result.current.set("-"))
    await act(async () => result.current.commit())
    expect(save).not.toHaveBeenCalled()
    expect(result.current.value).toBe("45")
  })

  it("does nothing on commit when no draft is held", async () => {
    const save = jest.fn()
    const { result } = setup<string>("x", save)
    await act(async () => result.current.commit())
    expect(save).not.toHaveBeenCalled()
  })

  it("keeps the sent draft until the write lands, then shows the persisted value", async () => {
    const { save, land } = deferredSave<string>()
    const { result, rerender } = setup<string>("old", save)

    act(() => result.current.set("new"))
    await act(async () => result.current.commit())
    // Still the draft: releasing before the store updates would flash "old".
    expect(result.current.value).toBe("new")

    rerender({ value: "new" })
    await land()
    expect(result.current.value).toBe("new")

    // Released: a later sync-down from the host is now reflected.
    rerender({ value: "from-host" })
    expect(result.current.value).toBe("from-host")
  })

  it("does not re-send a draft already sent (Enter, then blur)", async () => {
    const save = jest.fn(() => new Promise<void>(() => {}))
    const { result } = setup<string>("", save)

    act(() => result.current.set("claude"))
    act(() => result.current.commitOnEnter(key({ key: "Enter" })))
    await act(async () => result.current.commit())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("keeps a draft typed after the send when that write lands", async () => {
    const { save, land } = deferredSave<string>()
    const { result } = setup<string>("", save)

    act(() => result.current.set("first"))
    await act(async () => result.current.commit())
    act(() => result.current.set("second"))
    await land()
    expect(result.current.value).toBe("second")
  })

  it("commits on Enter, but not on an IME's candidate-confirming Enter", async () => {
    const save = jest.fn()
    const { result } = setup<string>("", save)
    act(() => result.current.set("zhong"))

    act(() => result.current.commitOnEnter(key({ key: "Enter", isComposing: true })))
    act(() => result.current.commitOnEnter(key({ key: "Enter", keyCode: 229 })))
    act(() => result.current.commitOnEnter(key({ key: "a" })))
    expect(save).not.toHaveBeenCalled()

    const enter = key({ key: "Enter" })
    await act(async () => result.current.commitOnEnter(enter))
    expect(enter.preventDefault).toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith("zhong")
  })

  it("writes a slider's committed value once, not each drag frame", async () => {
    const save = jest.fn()
    const { result } = setup<number>(1, save)

    act(() => result.current.set(1.1))
    act(() => result.current.set(1.2))
    act(() => result.current.set(1.3))
    expect(result.current.value).toBe(1.3)
    expect(save).not.toHaveBeenCalled()

    await act(async () => result.current.commitValue(1.3))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(1.3)
  })

  it("still writes a value equal to the persisted one while an earlier write is landing", async () => {
    const { save, land } = deferredSave<number>()
    const { result } = setup<number>(1, save)

    act(() => result.current.commitValue(1.5))
    // Dragged straight back before 1.5 landed: persisted is about to become
    // 1.5, so skipping this 1 would leave the setting at 1.5.
    act(() => result.current.commitValue(1))
    expect(save.mock.calls.map(([v]) => v)).toEqual([1.5, 1])

    await land(0)
    // One write still in flight: the draft stays.
    expect(result.current.value).toBe(1)
    await land(1)
    expect(result.current.value).toBe(1)
  })

  it("discards an unsent draft, but not one already sent", async () => {
    const save = jest.fn(() => new Promise<void>(() => {}))
    const { result } = setup<string>("stored", save)

    act(() => result.current.set("typo"))
    act(() => result.current.discard())
    expect(result.current.value).toBe("stored")
    await act(async () => result.current.commit())
    expect(save).not.toHaveBeenCalled()

    act(() => result.current.set("kept"))
    await act(async () => result.current.commit())
    act(() => result.current.discard())
    expect(result.current.value).toBe("kept")
  })

  it("writes an unsent draft on unmount rather than dropping it", async () => {
    const save = jest.fn()
    const { result, unmount } = setup<string>("", save)
    act(() => result.current.set("typed-then-left"))
    unmount()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith("typed-then-left")
  })

  it("does not write on unmount when the draft was already sent or never held", async () => {
    const save = jest.fn(() => new Promise<void>(() => {}))
    const sent = setup<string>("", save)
    act(() => sent.result.current.set("x"))
    act(() => sent.result.current.commit())
    sent.unmount()

    const idle = setup<string>("", save)
    idle.unmount()
    expect(save).toHaveBeenCalledTimes(1)
  })
})
