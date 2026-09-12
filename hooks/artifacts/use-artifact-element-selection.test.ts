/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  __resetArtifactPickersForTests,
  registerArtifactPicker,
  type ArtifactPickRequest,
} from "@/lib/artifacts/element-pick-registry"
import { useChatStore } from "@/stores/chat"
import type { Artifact } from "@/types"
import type { ElementSelectionCore } from "@/types/element-selection"

import {
  ARTIFACT_PICK_ORIGIN,
  locateElementRange,
  useArtifactElementSelection,
} from "./use-artifact-element-selection"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const addContextSelection = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: jest.fn(),
}))

const mockedUseChatStore = useChatStore as unknown as jest.Mock

function element(overrides: Partial<ElementSelectionCore> = {}): ElementSelectionCore {
  return {
    selector: "#card > button",
    domPath: "div.card > button",
    tagName: "button",
    id: null,
    classes: null,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    outerHTML: "<button>Go</button>",
    text: "Go",
    ...overrides,
  }
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "a1",
    title: "Landing",
    type: "html",
    content: "<div>\n  <button>Go</button>\n</div>",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...(overrides as object),
  } as Artifact
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetArtifactPickersForTests()
  mockedUseChatStore.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ addContextSelection })
  )
})

describe("locateElementRange", () => {
  it("finds markup that appears verbatim in the source", () => {
    const range = locateElementRange("<div>\n  <button>Go</button>\n</div>", element())
    expect(range).toEqual({ startLine: 2, endLine: 2 })
  })

  it("spans every line of a multi-line element", () => {
    const content = "<div>\n  <ul>\n    <li>a</li>\n  </ul>\n</div>"
    const range = locateElementRange(
      content,
      element({ outerHTML: "<ul>\n    <li>a</li>\n  </ul>" })
    )
    expect(range).toEqual({ startLine: 2, endLine: 4 })
  })

  it("falls back to an id anchor when the markup was normalised", () => {
    const content = '<div>\n  <button id="go" class="x">Go</button>\n</div>'
    const range = locateElementRange(
      content,
      element({ outerHTML: '<button class="x" id="go">Go</button>', id: "go" })
    )
    expect(range).toEqual({ startLine: 2, endLine: 2 })
  })

  it("falls back to a class anchor when there is no id", () => {
    const content = '<div>\n  <p class="lead big">hi</p>\n</div>'
    const range = locateElementRange(
      content,
      element({ outerHTML: "<p>hi</p>", classes: "lead big" })
    )
    expect(range).toEqual({ startLine: 2, endLine: 2 })
  })

  it("names the whole artifact when nothing can be traced to source", () => {
    // A chart drawn from data has no textual counterpart at all.
    const content = "line1\nline2\nline3"
    expect(locateElementRange(content, element({ outerHTML: "<svg><rect/></svg>" }))).toEqual({
      startLine: 1,
      endLine: 3,
    })
  })
})

describe("useArtifactElementSelection", () => {
  it("reports unavailable until a preview registers a picker", () => {
    const { result, rerender } = renderHook(
      (props: { previewVisible: boolean }) =>
        useArtifactElementSelection({ artifact: artifact(), ...props }),
      { initialProps: { previewVisible: true } }
    )
    expect(result.current.available).toBe(false)

    registerArtifactPicker("a1", { arm: jest.fn(), disarm: jest.fn() })
    rerender({ previewVisible: true })
    expect(result.current.available).toBe(true)
  })

  it("lights up the moment a preview registers, with no re-render of its own", () => {
    // The preview registers while it MOUNTS — after this hook's host has
    // already rendered and decided the toggle was disabled. Without a
    // subscription nothing would ever re-render it, and the button would sit
    // greyed out over a perfectly pickable preview.
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: true })
    )
    expect(result.current.available).toBe(false)

    act(() => {
      registerArtifactPicker("a1", { arm: jest.fn(), disarm: jest.fn() })
    })
    expect(result.current.available).toBe(true)
  })

  it("goes unavailable again when the preview unmounts", () => {
    let dispose = () => {}
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: true })
    )
    act(() => {
      dispose = registerArtifactPicker("a1", { arm: jest.fn(), disarm: jest.fn() })
    })
    expect(result.current.available).toBe(true)

    act(() => dispose())
    expect(result.current.available).toBe(false)
    expect(result.current.selectMode).toBe(false)
  })

  it("restores the mode the user asked for when the preview comes back", () => {
    registerArtifactPicker("a1", { arm: jest.fn(), disarm: jest.fn() })
    const { result, rerender } = renderHook(
      (props: { previewVisible: boolean }) =>
        useArtifactElementSelection({ artifact: artifact(), ...props }),
      { initialProps: { previewVisible: true } }
    )
    act(() => result.current.toggleSelectMode())
    expect(result.current.selectMode).toBe(true)

    rerender({ previewVisible: false })
    expect(result.current.selectMode).toBe(false)
    rerender({ previewVisible: true })
    expect(result.current.selectMode).toBe(true)
  })

  it("is unavailable while the preview is not showing, even with a picker registered", () => {
    registerArtifactPicker("a1", { arm: jest.fn(), disarm: jest.fn() })
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: false })
    )
    expect(result.current.available).toBe(false)
  })

  it("arms the picker with this surface's origin label", () => {
    const arm = jest.fn()
    registerArtifactPicker("a1", { arm, disarm: jest.fn() })
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: true })
    )

    act(() => result.current.toggleSelectMode())
    expect(result.current.selectMode).toBe(true)
    expect(arm).toHaveBeenCalledTimes(1)
    expect(arm.mock.calls[0][0].originLabel).toBe(ARTIFACT_PICK_ORIGIN)
  })

  it("disarms when select mode is switched off", () => {
    const disarm = jest.fn()
    registerArtifactPicker("a1", { arm: jest.fn(), disarm })
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: true })
    )

    act(() => result.current.toggleSelectMode())
    act(() => result.current.toggleSelectMode())
    expect(result.current.selectMode).toBe(false)
    expect(disarm).toHaveBeenCalled()
  })

  it("drops the toggle when there is no preview to arm, instead of leaving it lit", () => {
    // `available` is false here, but the toggle could still be pressed by a
    // keyboard shortcut racing an unmount.
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: true })
    )
    act(() => result.current.toggleSelectMode())
    expect(result.current.selectMode).toBe(false)
  })

  it("stages a plain pick as an artifact selection — the edit-target kind", () => {
    let request: ArtifactPickRequest | null = null
    registerArtifactPicker("a1", {
      arm: (req) => {
        request = req
      },
      disarm: jest.fn(),
    })
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: true })
    )
    act(() => result.current.toggleSelectMode())

    const picked = element({ componentName: "SubmitButton" })
    act(() => request!.onPick(picked, { metaKey: false, ctrlKey: false }))

    expect(addContextSelection).toHaveBeenCalledTimes(1)
    const staged = addContextSelection.mock.calls[0][0]
    expect(staged.kind).toBe("artifact")
    expect(staged.artifactId).toBe("a1")
    expect(staged.element).toBe(picked)
    expect(staged.range).toEqual({ startLine: 2, endLine: 2 })
    expect(result.current.pickedCount).toBe(1)
  })

  it("sends immediately on a modifier pick instead of staging", () => {
    const sendNow = jest.fn()
    let request: ArtifactPickRequest | null = null
    registerArtifactPicker("a1", {
      arm: (req) => {
        request = req
      },
      disarm: jest.fn(),
    })
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: true, sendNow })
    )
    act(() => result.current.toggleSelectMode())

    act(() => request!.onPick(element(), { metaKey: true, ctrlKey: false }))
    expect(sendNow).toHaveBeenCalledTimes(1)
    expect(addContextSelection).not.toHaveBeenCalled()

    act(() => request!.onPick(element(), { metaKey: false, ctrlKey: true }))
    expect(sendNow).toHaveBeenCalledTimes(2)
  })

  it("reads the artifact at pick time, not when the toggle was pressed", () => {
    let request: ArtifactPickRequest | null = null
    registerArtifactPicker("a1", {
      arm: (req) => {
        request = req
      },
      disarm: jest.fn(),
    })
    const { result, rerender } = renderHook(
      (props: { artifact: Artifact }) =>
        useArtifactElementSelection({ ...props, previewVisible: true }),
      { initialProps: { artifact: artifact() } }
    )
    act(() => result.current.toggleSelectMode())

    rerender({ artifact: artifact({ title: "Renamed" }) })
    act(() => request!.onPick(element(), { metaKey: false, ctrlKey: false }))
    expect(addContextSelection.mock.calls[0][0].title).toBe("Renamed")
  })

  it("ends select mode when the user escapes inside the preview", () => {
    let request: ArtifactPickRequest | null = null
    registerArtifactPicker("a1", {
      arm: (req) => {
        request = req
      },
      disarm: jest.fn(),
    })
    const { result } = renderHook(() =>
      useArtifactElementSelection({ artifact: artifact(), previewVisible: true })
    )
    act(() => result.current.toggleSelectMode())
    act(() => request!.onCancel?.())
    expect(result.current.selectMode).toBe(false)
  })

  it("ends select mode when the preview stops showing — an armed picker you cannot see is a trap", () => {
    registerArtifactPicker("a1", { arm: jest.fn(), disarm: jest.fn() })
    const { result, rerender } = renderHook(
      (props: { previewVisible: boolean }) =>
        useArtifactElementSelection({ artifact: artifact(), ...props }),
      { initialProps: { previewVisible: true } }
    )
    act(() => result.current.toggleSelectMode())
    expect(result.current.selectMode).toBe(true)

    rerender({ previewVisible: false })
    expect(result.current.selectMode).toBe(false)
  })

  it("resets when the dock moves to another artifact", () => {
    registerArtifactPicker("a1", { arm: jest.fn(), disarm: jest.fn() })
    registerArtifactPicker("a2", { arm: jest.fn(), disarm: jest.fn() })
    const { result, rerender } = renderHook(
      (props: { artifact: Artifact }) =>
        useArtifactElementSelection({ ...props, previewVisible: true }),
      { initialProps: { artifact: artifact() } }
    )
    act(() => result.current.toggleSelectMode())

    rerender({ artifact: artifact({ id: "a2" }) })
    expect(result.current.selectMode).toBe(false)
    expect(result.current.pickedCount).toBe(0)
  })

  it("ignores a pick that lands after the artifact is gone", () => {
    let request: ArtifactPickRequest | null = null
    registerArtifactPicker("a1", {
      arm: (req) => {
        request = req
      },
      disarm: jest.fn(),
    })
    const { result, rerender } = renderHook(
      (props: { artifact: Artifact | null }) =>
        useArtifactElementSelection({ ...props, previewVisible: true }),
      { initialProps: { artifact: artifact() as Artifact | null } }
    )
    act(() => result.current.toggleSelectMode())

    rerender({ artifact: null })
    act(() => request!.onPick(element(), { metaKey: false, ctrlKey: false }))
    expect(addContextSelection).not.toHaveBeenCalled()
  })
})
