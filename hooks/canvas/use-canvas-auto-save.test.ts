/**
 * Tests for useCanvasAutoSave hook
 */

import { renderHook, act } from "@testing-library/react"
import { useCanvasAutoSave } from "./use-canvas-auto-save"

const defaultOptions = {
  documentId: "doc-1",
  content: "initial content",
  onSave: jest.fn(),
  onContentUpdate: jest.fn(),
}

describe("useCanvasAutoSave", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("initial state", () => {
    it("should initialize with empty localContent", () => {
      const { result } = renderHook(() => useCanvasAutoSave(defaultOptions))
      expect(typeof result.current.localContent).toBe("string")
    })

    it("should start with hasUnsavedChanges false", () => {
      const { result } = renderHook(() => useCanvasAutoSave(defaultOptions))
      expect(result.current.hasUnsavedChanges).toBe(false)
    })

    it("should expose handleEditorChange and handleManualSave", () => {
      const { result } = renderHook(() => useCanvasAutoSave(defaultOptions))
      expect(typeof result.current.handleEditorChange).toBe("function")
      expect(typeof result.current.handleManualSave).toBe("function")
      expect(typeof result.current.discardChanges).toBe("function")
      expect(typeof result.current.setLocalContent).toBe("function")
    })
  })

  describe("handleEditorChange", () => {
    it("should update localContent", () => {
      const { result } = renderHook(() => useCanvasAutoSave(defaultOptions))

      act(() => {
        result.current.handleEditorChange("new content")
      })

      expect(result.current.localContent).toBe("new content")
    })

    it("should call onContentUpdate with document id", () => {
      const onContentUpdate = jest.fn()
      const { result } = renderHook(() => useCanvasAutoSave({ ...defaultOptions, onContentUpdate }))

      act(() => {
        result.current.handleEditorChange("new content")
      })

      expect(onContentUpdate).toHaveBeenCalledWith("doc-1", "new content")
    })

    it("should set hasUnsavedChanges when content differs from saved", () => {
      const { result } = renderHook(() => useCanvasAutoSave(defaultOptions))

      act(() => {
        result.current.handleEditorChange("different content")
      })

      expect(result.current.hasUnsavedChanges).toBe(true)
    })
  })

  describe("auto-save timer", () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it("should trigger auto-save after delay", () => {
      const onSave = jest.fn()
      const { result } = renderHook(() =>
        useCanvasAutoSave({ ...defaultOptions, onSave, autoSaveDelay: 5000 })
      )

      act(() => {
        result.current.handleEditorChange("auto-save content")
      })

      expect(onSave).not.toHaveBeenCalled()

      act(() => {
        jest.advanceTimersByTime(5000)
      })

      expect(onSave).toHaveBeenCalledWith("doc-1", undefined, true)
    })

    it("should debounce auto-save on rapid changes", () => {
      const onSave = jest.fn()
      const { result } = renderHook(() =>
        useCanvasAutoSave({ ...defaultOptions, onSave, autoSaveDelay: 5000 })
      )

      act(() => {
        result.current.handleEditorChange("change 1")
      })
      act(() => {
        jest.advanceTimersByTime(2000)
      })
      act(() => {
        result.current.handleEditorChange("change 2")
      })
      act(() => {
        jest.advanceTimersByTime(2000)
      })
      act(() => {
        result.current.handleEditorChange("change 3")
      })

      expect(onSave).not.toHaveBeenCalled()

      act(() => {
        jest.advanceTimersByTime(5000)
      })

      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave).toHaveBeenCalledWith("doc-1", undefined, true)
    })

    it("should clear auto-save timer on unmount", () => {
      const onSave = jest.fn()
      const { result, unmount } = renderHook(() =>
        useCanvasAutoSave({ ...defaultOptions, onSave, autoSaveDelay: 5000 })
      )

      act(() => {
        result.current.handleEditorChange("pending content")
      })

      unmount()

      act(() => {
        jest.advanceTimersByTime(10000)
      })

      expect(onSave).not.toHaveBeenCalled()
    })
  })

  describe("handleManualSave", () => {
    it("should call onSave when there are unsaved changes", () => {
      const onSave = jest.fn()
      const { result } = renderHook(() => useCanvasAutoSave({ ...defaultOptions, onSave }))

      act(() => {
        result.current.handleEditorChange("changed content")
      })

      expect(result.current.hasUnsavedChanges).toBe(true)

      act(() => {
        result.current.handleManualSave()
      })

      expect(onSave).toHaveBeenCalledWith("doc-1", undefined, false)
      expect(result.current.hasUnsavedChanges).toBe(false)
    })

    it("should not call onSave when no unsaved changes", () => {
      const onSave = jest.fn()
      const { result } = renderHook(() => useCanvasAutoSave({ ...defaultOptions, onSave }))

      act(() => {
        result.current.handleManualSave()
      })

      expect(onSave).not.toHaveBeenCalled()
    })

    it("should not call onSave when documentId is null", () => {
      const onSave = jest.fn()
      const { result } = renderHook(() =>
        useCanvasAutoSave({ ...defaultOptions, documentId: null, onSave })
      )

      act(() => {
        result.current.handleManualSave()
      })

      expect(onSave).not.toHaveBeenCalled()
    })
  })

  describe("discardChanges", () => {
    it("should restore last saved content and clear dirty state", async () => {
      const onContentUpdate = jest.fn()
      const { result } = renderHook(() => useCanvasAutoSave({ ...defaultOptions, onContentUpdate }))

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        result.current.handleEditorChange("dirty content")
      })

      expect(result.current.hasUnsavedChanges).toBe(true)
      expect(result.current.localContent).toBe("dirty content")

      act(() => {
        result.current.discardChanges()
      })

      expect(result.current.localContent).toBe("initial content")
      expect(result.current.hasUnsavedChanges).toBe(false)
      expect(onContentUpdate).toHaveBeenLastCalledWith("doc-1", "initial content")
    })
  })

  describe("saved baseline continuity", () => {
    it("should preserve dirty-state continuity across document switches using the last saved content baseline", async () => {
      const { result, rerender } = renderHook((props) => useCanvasAutoSave(props), {
        initialProps: {
          ...defaultOptions,
          content: "dirty draft",
          savedContent: "saved baseline",
        },
      })

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.localContent).toBe("dirty draft")
      expect(result.current.hasUnsavedChanges).toBe(true)

      await act(async () => {
        rerender({
          ...defaultOptions,
          documentId: "doc-2",
          content: "clean content",
          savedContent: "clean content",
        })
        await Promise.resolve()
      })

      expect(result.current.hasUnsavedChanges).toBe(false)

      await act(async () => {
        rerender({
          ...defaultOptions,
          documentId: "doc-1",
          content: "dirty draft",
          savedContent: "saved baseline",
        })
        await Promise.resolve()
      })

      expect(result.current.localContent).toBe("dirty draft")
      expect(result.current.hasUnsavedChanges).toBe(true)

      act(() => {
        result.current.discardChanges()
      })

      expect(result.current.localContent).toBe("saved baseline")
      expect(result.current.hasUnsavedChanges).toBe(false)
    })
  })
})
