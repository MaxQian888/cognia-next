/**
 * Test-only stub for `@cognia/plugin-ui` — see the sibling `plugin-sdk.ts` stub
 * for why these exist.
 *
 * These are intentionally the plainest possible elements: the real components
 * carry the host's theme tokens and Radix behaviour, none of which a unit test
 * should assert against. A test that cares about rendered markup should
 * `jest.mock` this module with its own factory, as `panel.test.tsx` does.
 */

import type { ReactNode } from "react"

export function Badge({ children }: { children?: ReactNode }) {
  return <span>{children}</span>
}

export function Button({ children, onClick }: { children?: ReactNode; onClick?: () => void }) {
  return <button onClick={onClick}>{children}</button>
}
