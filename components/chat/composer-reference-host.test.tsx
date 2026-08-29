/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

const stageMock = jest.fn()
const stagingOptionsMock = jest.fn()
jest.mock("@/hooks/chat/use-entity-mention-staging", () => ({
  useEntityMentionStaging: (opts: unknown) => {
    stagingOptionsMock(opts)
    return stageMock
  },
}))

import { ComposerReferenceHost } from "./composer-reference-host"
import { requestComposerReference } from "@/lib/chat/composer-reference-request"
import type { EntityMentionCandidate } from "@/lib/chat/mentions/entity-sources"

const candidate: EntityMentionCandidate = {
  entityKind: "memory",
  id: "mem_1",
  title: "Prefers pnpm",
  searchText: "prefers pnpm",
}

beforeEach(() => {
  stageMock.mockReset().mockResolvedValue(null)
  stagingOptionsMock.mockReset()
})

describe("ComposerReferenceHost", () => {
  it("renders nothing", () => {
    const { container } = render(<ComposerReferenceHost />)
    expect(container.firstChild).toBeNull()
  })

  // `sessionId: null` writes to the FOCUSED composer projection. A per-composer
  // subscription would stage the same reference into every open pane.
  it("stages into the focused composer, not a named one", () => {
    render(<ComposerReferenceHost />)
    expect(stagingOptionsMock).toHaveBeenCalledWith({ sessionId: null })
  })

  it("stages a requested reference", () => {
    render(<ComposerReferenceHost />)
    requestComposerReference(candidate)
    expect(stageMock).toHaveBeenCalledWith(candidate)
  })

  it("stops listening once unmounted", () => {
    const { unmount } = render(<ComposerReferenceHost />)
    unmount()
    requestComposerReference(candidate)
    expect(stageMock).not.toHaveBeenCalled()
  })

  // `stageEntity` reports its own failures as toasts and resolves to null; a
  // rejection must not take the root mount down with it.
  it("survives a staging failure", () => {
    stageMock.mockRejectedValue(new Error("gone"))
    render(<ComposerReferenceHost />)
    expect(() => requestComposerReference(candidate)).not.toThrow()
  })
})
