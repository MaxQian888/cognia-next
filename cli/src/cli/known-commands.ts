/**
 * The names the hand-written commands own.
 *
 * This lives apart from the dispatcher because two callers need it and they
 * would otherwise import each other: `index.ts` decides whether a bare word
 * under `--print` is a command or the start of a prompt, and `api-dispatch.ts`
 * has to know which protocol groups it must not shadow.
 */
export const KNOWN_COMMANDS = new Set([
  "run",
  "auth",
  "config",
  "handoff",
  "resume",
  "chat",
  "serve",
  "logto",
  "lark",
  "eval",
  "durability",
  "sdk",
  "x",
  "rpc",
  "worker",
  "attach",
  "detach",
  "sync",
  "backend",
  "security",
  "provider",
  "update",
  "api",
  "host",
])
