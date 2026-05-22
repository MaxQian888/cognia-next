# Cognia PowerShell shell integration.
#
# Wraps the existing `$function:prompt` so we can emit OSC 633 sequences
# every time PowerShell prints a prompt — that's the only universally-
# available hook in PowerShell 5/7. We surface D (command end + exit
# code), P (cwd), A (prompt start), then the original prompt, then B
# (prompt end).
#
# PSReadLine integration (Wave 3C): when the PSReadLine module is loaded
# we additionally wrap the `AcceptLine` key handler to emit OSC 633 C
# (command pre-exec). This makes the tab status flip to "Running" the
# moment the user presses Enter on Windows, matching the bash/zsh
# behaviour. Missing PSReadLine is silently tolerated — `Get-Module` is
# our gate.

if (-not $env:COGNIA_TERM_NONCE) { return }

$Global:__CogniaTermNonce = $env:COGNIA_TERM_NONCE

function Global:__Cognia-Emit {
    param([string]$Cmd)
    [Console]::Write("`e]633;{0};{1}`a" -f $Cmd, $Global:__CogniaTermNonce)
}

function Global:__Cognia-EmitWith {
    param([string]$Cmd, [string]$Arg)
    [Console]::Write("`e]633;{0};{1};{2}`a" -f $Cmd, $Global:__CogniaTermNonce, $Arg)
}

# Capture whatever prompt the user (or $PROFILE) set up so we can compose.
# Defaults to the built-in prompt when nothing custom is registered.
if (-not (Get-Variable -Name __CogniaOriginalPrompt -Scope Global -ErrorAction SilentlyContinue)) {
    $Global:__CogniaOriginalPrompt = $function:prompt
    if (-not $Global:__CogniaOriginalPrompt) {
        $Global:__CogniaOriginalPrompt = { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
    }
}

function Global:prompt {
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
    __Cognia-EmitWith 'D' $exitCode
    __Cognia-EmitWith 'P' ("Cwd=" + (Get-Location).Path)
    __Cognia-Emit 'A'
    $rendered = & $Global:__CogniaOriginalPrompt
    __Cognia-Emit 'B'
    return $rendered
}

# PSReadLine OSC 633 C (command pre-exec) hook.
#
# We install a custom AcceptLine key handler that fires the OSC 633 C
# sequence *before* delegating to PSReadLine's default AcceptLine. The
# guard checks for the cmdlet rather than `Get-Module` first because
# PSReadLine 2.0+ may be present but auto-loaded only on Enter — looking
# up the cmdlet forces the module to load if available.
if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
    try {
        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
            __Cognia-Emit 'C'
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
        # Multi-line edits also commit via Ctrl+Enter on Windows terminal —
        # mirror the hook so the renderer sees the C marker either way.
        Set-PSReadLineKeyHandler -Key Ctrl+Enter -ScriptBlock {
            __Cognia-Emit 'C'
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
    } catch {
        # Older PSReadLine builds may not accept ScriptBlock for Enter
        # without -ViMode parity. Silently leave the default handler in
        # place — the renderer still gets accurate D/A/B events.
    }
}
