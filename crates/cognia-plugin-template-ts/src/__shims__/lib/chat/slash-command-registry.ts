/**
 * Test-time shim for `@/lib/chat/slash-command-registry`. The real registry
 * lives in the cognia app; at test time we replace it with jest mocks so
 * the template can be tested in isolation.
 *
 * `jest.mock("@/lib/chat/slash-command-registry", ...)` in test files
 * intercepts this module before any of the named exports are touched.
 */

export const registerSlashCommand = (_command: unknown): void => {
  // Replaced by jest.mock at test time.
}

export const unregisterCommandsByPlugin = (_pluginId: string): void => {
  // Replaced by jest.mock at test time.
}
