/**
 * The first-run flow's route (ADR-0122).
 *
 * A constant rather than a string literal at each call site because three
 * places have to agree on it — the gate that redirects into it, the page that
 * serves it, and the Settings "re-run setup" entry point — and a typo in any
 * one of them produces a redirect loop rather than a build error.
 */
export const ONBOARDING_ROUTE = "/onboarding"
