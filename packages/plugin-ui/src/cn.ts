import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Class-name merger, identical in behavior to the host's `@/lib/utils` `cn`.
 * Duplicated rather than imported because this package must resolve with zero
 * `@/` app paths — see the note in README.md on why the fork is deliberate.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
