---
"cognia-next": minor
---

MCP settings: add live search against the official MCP Registry, sync to Zed / Kiro / opencode, and replace six deprecated server presets.

- The "Add server" gallery now searches registry.modelcontextprotocol.io alongside the curated catalog, so any published server can be installed without hand-writing config.
- New sync targets: Zed (`context_servers`), Kiro (`~/.kiro/settings/mcp.json`) and opencode (`~/.config/opencode/opencode.json`), bringing the total to 13.
- The GitHub, GitLab, Brave Search, Postgres, Puppeteer and Slack presets pointed at npm packages that are now marked "no longer supported" and could not start. They now use each project's current server (GitHub's official remote endpoint, `@playwright/mcp` in place of Puppeteer, and so on).
- Server and preset cards in grid view now fill their row, so cards line up instead of stair-stepping by content height.
