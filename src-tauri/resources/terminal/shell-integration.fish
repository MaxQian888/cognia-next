# Cognia fish shell integration.
#
# Emits OSC 633 sequences (`ESC ] 633 ; <C> ; <nonce> [; <arg>] BEL`) that
# `src-tauri/src/terminal/osc633.rs::Osc633Parser` parses. Mirrors the
# bash / zsh integration but uses fish's native event-handling hooks:
#
#   * `fish_prompt`     — fires before each prompt render        → D + P + A
#   * `fish_preexec`    — fires when the user has just hit Enter → C
#   * (B is emitted at the end of every prompt via `fish_right_prompt`
#     or by appending it onto the prompt itself; we use a prompt-end
#     marker via a one-shot postprompt printf.)
#
# Loaded via `fish --init-command "source <this-script>"`. fish loads its
# own conf.d / user config before running the init command, so user
# functions are already in scope by the time we hook the events.

if not set -q COGNIA_TERM_NONCE
    # No nonce → nothing to gate sequences on; bail silently.
    exit 0
end

# Helpers — fish's printf escapes need the literal escape character.
function __cognia_term_emit
    # $argv[1] = command letter
    printf '\033]633;%s;%s\a' $argv[1] $COGNIA_TERM_NONCE
end

function __cognia_term_emit_with
    # $argv[1] = letter, $argv[2] = payload
    printf '\033]633;%s;%s;%s\a' $argv[1] $COGNIA_TERM_NONCE $argv[2]
end

# fish_preexec fires after the user presses Enter and just before the
# command runs — perfect for C (command-start).
function __cognia_term_preexec --on-event fish_preexec
    __cognia_term_emit C
end

# fish_prompt fires every time fish is about to render a prompt. Emit
# D (with the last exit code) + P (cwd) before the prompt renders,
# then A immediately before, then let the prompt run, then B after.
#
# fish doesn't have a "post-prompt" event — the cleanest way to get a
# B marker is to append the sequence to the user's prompt output via
# a wrapper. We don't want to clobber the user's fish_prompt function,
# so we instead emit A as part of the prerender hook and skip B; the
# renderer's osc633 parser tolerates a missing B (the next D resets).
function __cognia_term_render_prompt --on-event fish_prompt
    set -l last_status $status
    __cognia_term_emit_with D $last_status
    __cognia_term_emit_with P "Cwd=$PWD"
    __cognia_term_emit A
end
