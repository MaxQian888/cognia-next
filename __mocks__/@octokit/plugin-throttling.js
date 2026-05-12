/**
 * Manual Jest mock for `@octokit/plugin-throttling`. The real plugin attaches
 * rate-limit handling hooks; for unit tests we just need a no-op function the
 * factory accepts as a plugin.
 */

function throttling() {
  // The plugin signature is (octokit, options) => unknown; we don't need to
  // do anything because tests don't trigger real GitHub responses.
}

module.exports = { throttling }
