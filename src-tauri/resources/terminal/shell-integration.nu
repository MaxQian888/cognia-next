# Cognia nushell shell integration.
#
# Emits OSC 633 sequences (`ESC ] 633 ; <C> ; <nonce> [; <arg>] BEL`) that
# `src-tauri/src/terminal/osc633.rs::Osc633Parser` parses. Loaded via
# `nu --config <tempdir>/config.nu` (the integration setup builder
# appends this file to a temp config that re-sources the user's regular
# config first).
#
# Nushell exposes lifecycle hooks under `$env.config.hooks`:
#
#   * pre_prompt     — fires before each prompt render          → D + P + A
#   * pre_execution  — fires after the user submits a command   → C
#   * post_execution — fires after a command finishes (no exit code surfaced)
#
# Limitations vs bash/zsh/fish:
#   * Nushell's `pre_prompt` does not surface the last exit code reliably
#     across versions (`$env.LAST_EXIT_CODE` is unset before the very first
#     prompt and after intrinsic exits). We emit `D;0` and rely on the
#     renderer treating any non-zero status as "unknown" downstream.
#   * No post-prompt hook ⇒ we don't emit B. The osc633 parser tolerates
#     a missing B (the next D + A pair resets the prompt frame).

# No nonce → bail silently.
if ($env.COGNIA_TERM_NONCE? | is-empty) {
    return
}

let __nonce = $env.COGNIA_TERM_NONCE

def __cognia-emit [cmd: string] {
    print -n $"(char esc)]633;($cmd);($__nonce)(char bel)"
}

def __cognia-emit-with [cmd: string, arg: string] {
    print -n $"(char esc)]633;($cmd);($__nonce);($arg)(char bel)"
}

# Merge our hooks into the user's existing $env.config.hooks. nushell's
# `upsert` deep-merges so any user-defined hooks survive.
$env.config = ($env.config | default {} | upsert hooks {
    let existing = ($in.hooks? | default {})
    $existing
    | upsert pre_prompt (($existing.pre_prompt? | default []) | append {
        # Best-effort exit code. Empty string when unset → emit 0.
        let code = ($env.LAST_EXIT_CODE? | default 0)
        __cognia-emit-with D ($code | into string)
        __cognia-emit-with P $"Cwd=($env.PWD)"
        __cognia-emit A
    })
    | upsert pre_execution (($existing.pre_execution? | default []) | append {
        __cognia-emit C
    })
})
