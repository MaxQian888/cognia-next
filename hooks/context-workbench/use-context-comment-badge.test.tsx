import { renderHook } from "@testing-library/react"
import { useLiveQuery } from "dexie-react-hooks"
import { useContextCommentBadge } from "./use-context-comment-badge"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))

it("returns the reactive unresolved root-comment count", () => {
  jest.mocked(useLiveQuery).mockReturnValue([{}, {}, {}] as never)
  expect(renderHook(() => useContextCommentBadge("artifact", "artifact-1")).result.current).toBe(3)
})
