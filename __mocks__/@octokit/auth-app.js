/**
 * Manual Jest mock for `@octokit/auth-app`.
 *
 * Tests that exercise installation-token caching inject their own minter via
 * `RefreshDeps.mintToken`, so this mock only needs to keep the `createAppAuth`
 * factory invocation from crashing. The default async returns a static token
 * with a 1-hour expiry — sufficient for any test that forgets to inject a
 * minter (it will just behave as if a token were freshly issued).
 */

function createAppAuth(_cfg) {
  return async (_call) => ({
    type: "token",
    tokenType: "installation",
    token: "ghs_mock_installation_token",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  })
}

module.exports = { createAppAuth }
