/**
 * The plugin contract's share of `lib/agent-roots/index.ts`, which re-exports these.
 */
/**
 * Absolute per-vendor root directories. An empty string means "not resolvable
 * on this host" — callers must treat it as "this vendor cannot be scanned"
 * rather than joining onto `""` and walking from the filesystem root.
 *
 * Mirrors `src-tauri/src/agents/paths.rs:VendorRoots` field for field.
 */
export interface VendorRoots {
  /** `$CLAUDE_CONFIG_DIR` or `<home>/.claude`. */
  claudeConfigDir: string
  /** `$CODEX_HOME` or `<home>/.codex`. */
  codexHome: string
  /** `$XDG_CONFIG_HOME/opencode`, `%APPDATA%/opencode`, or `<home>/.config/opencode`. */
  opencodeConfigDir: string
  /** `$XDG_DATA_HOME/opencode`, `%APPDATA%/opencode`, or `<home>/.local/share/opencode`. */
  opencodeDataDir: string
  /** Platform data fallback retained alongside XDG (e.g. redirected `%APPDATA%`). */
  opencodePlatformDataDir?: string
  /**
   * `$PI_CODING_AGENT_DIR` or `<home>/.pi/agent` — Pi's user-scope config dir
   * (`settings.json`, `mcp.json`, `subagents.json`, per-extension configs).
   *
   * Note this is the *agent* dir, not `~/.pi`: Pi's own `getAgentDir()` is
   * env-first, else `join(homedir(), ".pi", "agent")`. Pi's project scope is
   * always `<cwd>/.pi` and is NOT relocated by the variable.
   */
  piAgentDir: string
  /** `$PI_CODING_AGENT_SESSION_DIR` or `<piAgentDir>/sessions`. */
  piSessionDir: string
  /**
   * `<home>/.gemini` — Gemini CLI's user-scope directory (session transcripts
   * live under `tmp/`).
   *
   * Home-relative with NO environment override, deliberately: no relocation
   * variable for Gemini CLI is confirmed against upstream, and declaring one
   * would be a path this module claims to honour and does not. It is carried
   * here anyway so the renderer stops deriving it — `adapters/gemini-cli.ts`
   * and `adapters/continue-dev.ts` were the only two session sources still
   * joining onto a bare `home`, which is precisely the drift this module was
   * created to end (see the header note about `codex.ts`).
   */
  geminiDir: string
  /**
   * `<home>/.continue` — Continue's global directory (session JSON lives under
   * `sessions/`). Home-relative, no confirmed override; see {@link geminiDir}.
   */
  continueDir: string
  /**
   * `<home>/.cursor` — Cursor's user-scope directory; its `skills/` tree is
   * scanned by the skill-discovery surface. Home-relative, no confirmed
   * override; see {@link geminiDir}.
   */
  cursorDir: string
}
