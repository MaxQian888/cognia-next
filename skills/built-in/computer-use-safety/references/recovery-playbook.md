# Computer-use recovery playbook

Concrete responses to the failure modes you'll actually hit. The rule behind all of them: re-observe before you re-act.

## Failure → response

| Symptom | Likely cause | Do this |
| --- | --- | --- |
| Click had no effect | Element moved / not yet rendered / wrong coords | New screenshot; re-locate the element; click the fresh coordinates |
| Same screen after an action | Action didn't register, or a modal intercepted it | Screenshot; if a dialog is up, handle it first |
| Unexpected dialog / popup | Permission prompt, autosave, "are you sure?" | Read it; decide deliberately; never blind-Enter |
| Page/app still loading | Slow network or heavy app | Wait, then screenshot; don't stack actions on an unsettled UI |
| Text typed into wrong field | Focus wasn't where you assumed | Clear if safe; click the intended field; retype |
| App crashed / window gone | Hard failure | Stop; report state; don't relaunch-and-retry blindly |

## Destructive-action checklist (confirm before, every time)
- Send / post / submit to a person or service
- Delete / overwrite / move files; empty trash; uninstall
- Purchase / payment / irreversible transaction
- Change system settings, permissions, or credentials

Reversible-in-one-step (read, scroll, navigate, open) needs no confirmation.
The host owns the approval prompt and the resulting capability grant. Never click
an approval dialog yourself, infer approval from silence, or continue when the
host denies or withholds the capability.

## The two-attempt rule
After two honest attempts at the same step fail, stop and report what's on screen. A third blind retry on a live machine is how real damage happens — a human looking at the screenshot will resolve in seconds what more clicking won't.

## Coordinate hygiene
Never reuse coordinates from an earlier screenshot after any state change. Scroll position, window size, and dynamic layout all invalidate old coordinates. Locate fresh, every time.
