---
"cognia-next": minor
---

Delegated tasks, steering, human handoff, and difficulty-aware routing.

**A handed-over task now has a run of its own.** Every execution kind named the
engine that was running — so a delegation whose turn failed was simply a failed
turn, and nothing owned the commitment. `delegation` runs own the engine runs
that carry them out, project their progress onto **one** card instead of one per
child, and survive the process that started them: the bridge re-derives the
parent from its children's current rows, so it is still correct after a crash it
never observed. Accepting a delegation opens its card in the same tick, instead
of leaving the person wondering for the length of a planning pass whether their
request was heard.

**Work in flight can be redirected instead of only stopped.** A new `steer`
control reaches a team's every active worker (steering only the lead left the
workers running on the instruction just corrected), an agent turn's live input
lane, or a delegation's children. It arrives from a chat thread as
`steer: …` / `调整：…`, and — unlike a button — typing one does not consume the
control, because a person redirecting a long run says several things over its
life. A steer that cannot be applied is reported as _degraded_, not refused: the
message is intact, so it is handed back to the normal pipeline and queued as a
turn rather than dropped or sent twice.

**A stuck task can be given to a person without ending it.** `/handoff [name]`
parks the delegation on a human and delivers a brief assembled from what the run
already knows — what was asked, what is done, what was tried, where it stuck,
what decision is outstanding. `/handoff back [note]` returns it as a `resume` on
the same run, with the note travelling as a steer. An overdue handoff is marked
overdue, never silently expired out from under the person holding it.

**A team run started from chat now asks about its plan instead of failing.**
Headless used to mean "no human exists", which is true at 3am and false in a
chat thread; when the caller can prove it has a reachable human, the plan gate
asks there, and a rejection's feedback becomes the lead's next revision
instruction.

**▶ Run stops guessing which engine.** It used to dispatch to whichever adapter
registered first; with more than one able to take an issue it now asks, and
stays one tap when only one can.

**Routing reads what the request already knew.** Difficulty was scored from
prompt text alone while attachments, thread depth, tool reach, and the effort
level the user had explicitly chosen sat unread on the same request. All of them
now count, each reported separately so thresholds can be tuned from evidence. An
optional second-opinion judge is consulted only when the score sits near a tier
boundary — an unambiguous prompt never pays for it — and any failure leaves the
deterministic answer exactly where it was. Off by default, behind Auto routing's
own switch.
