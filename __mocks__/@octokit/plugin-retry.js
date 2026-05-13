/**
 * Manual Jest mock for `@octokit/plugin-retry`. No-op for unit tests.
 */

function retry() {
  // The plugin signature is (octokit, options) => unknown; no-op for tests.
}

module.exports = { retry }
