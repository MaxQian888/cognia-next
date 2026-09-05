---
"cognia-next": minor
---

cognia-agent can now call any command a Cognia Host exposes. `api call`,
`list`, `describe`, `schema` and `request`, plus derived resource commands so
`plugin list` is `api call plugin_list`. The surface is generated from the
frozen protocol contract, so it covers all 656 commands on the headless wire
and 527 on the paired-device wire, and a bad call is refused locally with the
field it did not recognise rather than arriving as a 422. Hosts are saved
records now (`host add/use/list/show/login/remove`) with `host show` reporting
where every value came from.
