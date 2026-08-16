/**
 * The root workspace picks up jest-dom's matcher types because `jest.setup.ts`
 * sits inside the root TypeScript program. This workspace has its own program
 * that stops at `docs/`, so the same augmentation has to be pulled in here or
 * every `toBeInTheDocument()` in a co-located test fails to typecheck.
 */
import "@testing-library/jest-dom"
