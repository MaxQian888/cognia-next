/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

let params = new URLSearchParams()
const router = { push: jest.fn(), replace: jest.fn() }
jest.mock("next/navigation", () => ({
  useSearchParams: () => params,
  useRouter: () => router,
}))

import { useFilesLibraryStore } from "@/stores/files-library"
import { useFilesDeepLink } from "./use-files-deep-link"

beforeEach(() => {
  params = new URLSearchParams()
  router.replace.mockClear()
  useFilesLibraryStore.setState({
    section: { kind: "all" },
    lens: "suggested",
    selectedKey: null,
  })
})

it("applies the place, lens and previewed item a link carries", () => {
  params = new URLSearchParams("section=group%3Aimages&tab=favorites&item=image%3Ah1")
  renderHook(() => useFilesDeepLink())
  const state = useFilesLibraryStore.getState()
  expect(state.section).toEqual({ kind: "group", group: "images" })
  expect(state.lens).toBe("favorites")
  expect(state.selectedKey).toBe("image:h1")
  expect(router.replace).not.toHaveBeenCalled()
})

it("rewrites an ADR-0200 ?tab= link to the place it meant", () => {
  params = new URLSearchParams("tab=images")
  renderHook(() => useFilesDeepLink())
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "group", group: "images" })
  expect(router.replace).toHaveBeenCalledWith("/files?section=group%3Aimages")
})

it("writes the place and lens the person picks, and nothing before that", () => {
  renderHook(() => useFilesDeepLink())
  expect(router.replace).not.toHaveBeenCalled()
  act(() => useFilesLibraryStore.getState().setSection({ kind: "trash" }))
  expect(router.replace).toHaveBeenLastCalledWith("/files?section=trash")
  act(() => useFilesLibraryStore.getState().setLens("mine"))
  expect(router.replace).toHaveBeenLastCalledWith("/files?section=trash&tab=mine")
})
