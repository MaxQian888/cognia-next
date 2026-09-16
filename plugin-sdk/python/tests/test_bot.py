"""Bot capability: manifest declaration and durable-step sugar."""

from __future__ import annotations

import asyncio

import pytest

import cognia
from cognia.bot import BotRun, BotRunParked, bot_run, define_bot


class TestDefineBot:
    def test_emits_the_camel_case_manifest_shape(self):
        bot = define_bot(
            id="digest",
            name="Daily digest",
            version="1.2.0",
            executor="handler",
            triggers=[{"id": "morning", "kind": "schedule", "cron": "0 9 * * 1-5"}],
            description="Posts a morning summary.",
            policy={"maxAutonomy": "confirm"},
            config_schema={"type": "object"},
        )

        assert bot.to_dict() == {
            "id": "digest",
            "name": "Daily digest",
            "version": "1.2.0",
            "executor": "handler",
            "triggers": [{"id": "morning", "kind": "schedule", "cron": "0 9 * * 1-5"}],
            "description": "Posts a morning summary.",
            "policy": {"maxAutonomy": "confirm"},
            "configSchema": {"type": "object"},
        }

    def test_requires_the_executor_specific_field(self):
        with pytest.raises(ValueError, match="requires a 'workflow'"):
            define_bot(
                id="x",
                name="X",
                version="1.0.0",
                executor="workflow",
                triggers=[{"id": "m", "kind": "manual"}],
            )

    def test_refuses_a_field_belonging_to_another_executor(self):
        # Declaring both is how a definition ends up meaning two things.
        with pytest.raises(ValueError, match="must not declare 'team'"):
            define_bot(
                id="x",
                name="X",
                version="1.0.0",
                executor="workflow",
                workflow="wf_1",
                team="team_1",
                triggers=[{"id": "m", "kind": "manual"}],
            )

    def test_handler_executor_needs_no_extra_field(self):
        bot = define_bot(
            id="h",
            name="H",
            version="1.0.0",
            executor="handler",
            triggers=[{"id": "m", "kind": "manual"}],
        )
        assert "entry" not in bot.to_dict()

    def test_refuses_a_bot_with_no_trigger(self):
        with pytest.raises(ValueError, match="at least one trigger"):
            define_bot(
                id="x", name="X", version="1.0.0", executor="handler", triggers=[]
            )

    @pytest.mark.parametrize(
        "trigger,message",
        [
            ({"id": "e", "kind": "nope"}, "unknown kind"),
            ({"kind": "manual"}, "non-empty 'id'"),
            ({"id": "e", "kind": "event", "types": ["a"]}, "needs a 'source'"),
            (
                {"id": "e", "kind": "event", "source": "integration", "types": []},
                "non-empty 'types'",
            ),
            ({"id": "s", "kind": "schedule"}, "needs a 'cron'"),
            ({"id": "p", "kind": "poll"}, "integer 'everyMs'"),
            (
                {"id": "d", "kind": "derivedState", "everyMs": 60000},
                "needs a 'state'",
            ),
            (
                {"id": "p", "kind": "poll", "everyMs": 5000},
                "at least 15000ms",
            ),
        ],
    )
    def test_validates_each_trigger_kind(self, trigger, message):
        with pytest.raises(ValueError, match=message):
            define_bot(
                id="x",
                name="X",
                version="1.0.0",
                executor="handler",
                triggers=[trigger],
            )

    def test_accepts_conditions_match_scalars_and_lists(self):
        bot = define_bot(
            id="x",
            name="X",
            version="1.0.0",
            executor="handler",
            triggers=[
                {
                    "id": "e",
                    "kind": "event",
                    "source": "integration",
                    "types": ["t"],
                    "conditions": {
                        "match": {"payload.event.type": "message", "payload.n": [1, 2]}
                    },
                }
            ],
        )
        assert bot.triggers[0]["conditions"]["match"]["payload.event.type"] == "message"

    @pytest.mark.parametrize(
        "match",
        [
            "message",
            {"bad path!": "x"},
            {"payload.a": {"nested": True}},
            {"payload.a": []},
        ],
    )
    def test_rejects_invalid_conditions_match(self, match):
        with pytest.raises(ValueError, match="conditions.match"):
            define_bot(
                id="x",
                name="X",
                version="1.0.0",
                executor="handler",
                triggers=[
                    {
                        "id": "e",
                        "kind": "event",
                        "source": "integration",
                        "types": ["t"],
                        "conditions": {"match": match},
                    }
                ],
            )

    @pytest.mark.parametrize(
        "retry,message",
        [
            ("fast", "'retry' must be an object"),
            ({"maxAttempts": 0}, "maxAttempts"),
            ({"maxAttempts": 6}, "maxAttempts"),
            ({"baseDelayMs": 0}, "baseDelayMs"),
            ({"baseDelayMs": 5000, "maxDelayMs": 1000}, "maxDelayMs"),
        ],
    )
    def test_rejects_invalid_retry_policies(self, retry, message):
        with pytest.raises(ValueError, match=message):
            define_bot(
                id="x",
                name="X",
                version="1.0.0",
                executor="handler",
                triggers=[{"id": "p", "kind": "poll", "everyMs": 60000, "retry": retry}],
            )

    def test_accepts_config_keys_on_the_right_kinds(self):
        define_bot(
            id="x",
            name="X",
            version="1.0.0",
            executor="handler",
            config_schema={
                "type": "object",
                "properties": {"schedule": {}, "zone": {}, "interval": {}},
            },
            triggers=[
                {
                    "id": "s",
                    "kind": "schedule",
                    "cron": "0 9 * * *",
                    "cronConfigKey": "schedule",
                    "timezoneConfigKey": "zone",
                },
                {"id": "p", "kind": "poll", "everyMs": 60000, "everyMsConfigKey": "interval"},
            ],
        )

    @pytest.mark.parametrize(
        "trigger,key",
        [
            ({"id": "p", "kind": "poll", "everyMs": 60000}, "cronConfigKey"),
            ({"id": "m", "kind": "manual"}, "timezoneConfigKey"),
            ({"id": "s", "kind": "schedule", "cron": "0 9 * * *"}, "everyMsConfigKey"),
        ],
    )
    def test_rejects_config_keys_on_the_wrong_kind(self, trigger, key):
        trigger[key] = "schedule"
        with pytest.raises(ValueError, match="only valid"):
            define_bot(
                id="x",
                name="X",
                version="1.0.0",
                executor="handler",
                config_schema={"type": "object", "properties": {"schedule": {}}},
                triggers=[trigger],
            )

    @pytest.mark.parametrize("config_schema", [None, {"type": "object", "properties": {}}])
    def test_rejects_config_key_naming_no_schema_property(self, config_schema):
        with pytest.raises(ValueError, match="configSchema properties"):
            define_bot(
                id="x",
                name="X",
                version="1.0.0",
                executor="handler",
                config_schema=config_schema,
                triggers=[
                    {
                        "id": "s",
                        "kind": "schedule",
                        "cron": "0 9 * * *",
                        "cronConfigKey": "schedule",
                    }
                ],
            )

    def test_is_exported_from_the_package_root(self):
        assert cognia.define_bot is define_bot
        assert cognia.BOT_EXECUTORS == ("workflow", "squad", "agent-turn", "handler")


def test_approval_request_serializes_policy_mode_without_granting_authority():
    import json
    from cognia.bot import BotApprovalRequest

    proposal = BotApprovalRequest(
        title="Publish exact result",
        decisionMode="policy",
        detail={"approvedActions": [{"actionId": "reviewPr", "input": {"body": "exact"}}]},
        timeoutMs=60_000,
    )
    assert json.loads(json.dumps(proposal)) == proposal
    assert proposal["decisionMode"] == "policy"
    assert "decisionMode" not in BotApprovalRequest(title="Human review")


SNAPSHOT = {
    "runId": "run_1",
    "installationId": "inst_1",
    "botId": "acme:digest",
    "event": {"eventId": "bev_1", "type": "schedule.tick"},
    "config": {"channel": "#ops"},
}


def _host_recorder(fresh_runtime, replies=None):
    """Attach a host-call stub that records calls and answers from `replies`."""
    calls = []
    replies = replies or {}

    def handler(method, params):
        calls.append((method, params))
        return replies.get(method)

    fresh_runtime.set_host_call_handler(handler)
    return calls


class TestBotRun:
    def test_exposes_the_snapshot_fields(self):
        run = bot_run(cognia.ctx, SNAPSHOT)
        assert run.run_id == "run_1"
        assert run.installation_id == "inst_1"
        assert run.bot_id == "acme:digest"
        assert run.event["eventId"] == "bev_1"
        assert run.config == {"channel": "#ops"}

    def test_step_completes_with_the_holder_value(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime, {"bots.stepBegin": {"memoized": False, "attempt": 1}})
        run = bot_run(cognia.ctx, SNAPSHOT)

        async def main():
            async with run.step("fetch") as step:
                assert step.memoized is False
                step.complete({"items": 3})

        asyncio.run(main())
        assert calls == [
            ("bots.stepBegin", {"args": ["run_1", "fetch"]}),
            ("bots.stepComplete", {"args": ["run_1", "fetch", {"items": 3}]}),
        ]

    def test_step_defaults_to_none_when_never_completed(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime, {"bots.stepBegin": {"memoized": False, "attempt": 1}})
        run = bot_run(cognia.ctx, SNAPSHOT)

        async def main():
            async with run.step("fetch"):
                pass

        asyncio.run(main())
        assert calls[-1] == ("bots.stepComplete", {"args": ["run_1", "fetch", None]})

    def test_step_replays_a_memoized_value_without_completing(self, fresh_runtime):
        calls = _host_recorder(
            fresh_runtime, {"bots.stepBegin": {"memoized": True, "value": {"items": 3}}}
        )
        run = bot_run(cognia.ctx, SNAPSHOT)

        async def main():
            async with run.step("fetch") as step:
                assert step.memoized is True
                assert step.value == {"items": 3}

        asyncio.run(main())
        assert calls == [("bots.stepBegin", {"args": ["run_1", "fetch"]})]

    def test_step_fails_and_reraises_on_body_error(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime, {"bots.stepBegin": {"memoized": False, "attempt": 2}})
        run = bot_run(cognia.ctx, SNAPSHOT)

        async def main():
            async with run.step("fetch"):
                raise RuntimeError("upstream 500")

        with pytest.raises(RuntimeError, match="upstream 500"):
            asyncio.run(main())
        assert calls[-1] == ("bots.stepFail", {"args": ["run_1", "fetch", "upstream 500"]})

    def test_wait_for_approval_returns_the_decision(self, fresh_runtime):
        decision = {"outcome": "approved", "decidedAt": 42}
        _host_recorder(
            fresh_runtime,
            {"bots.waitForApproval": {"status": "settled", "value": decision}},
        )
        run = bot_run(cognia.ctx, SNAPSHOT)
        request = {"title": "Publish?", "detail": {"sha": "abc"}}
        assert asyncio.run(run.wait_for_approval("publish", request)) == decision

    def test_wait_for_approval_raises_parked(self, fresh_runtime):
        _host_recorder(
            fresh_runtime,
            {
                "bots.waitForApproval": {
                    "status": "parked",
                    "stepName": "publish",
                    "resumeAt": 1234,
                    "waitingFor": "bot-approval:sha",
                }
            },
        )
        run = bot_run(cognia.ctx, SNAPSHOT)
        with pytest.raises(BotRunParked) as excinfo:
            asyncio.run(run.wait_for_approval("publish", {"title": "Publish?"}))
        assert excinfo.value.step_name == "publish"
        assert excinfo.value.resume_at == 1234
        assert excinfo.value.waiting_for == "bot-approval:sha"

    def test_wait_for_event_settled_and_parked(self, fresh_runtime):
        envelope = {"eventId": "bev_9"}
        calls = _host_recorder(
            fresh_runtime,
            {"bots.waitForEvent": {"status": "settled", "value": envelope}},
        )
        run = bot_run(cognia.ctx, SNAPSHOT)
        assert asyncio.run(run.wait_for_event("ci", "key-1", 60_000)) == envelope
        assert calls == [
            ("bots.waitForEvent", {"args": ["run_1", "ci", {"key": "key-1", "timeoutMs": 60000}]})
        ]

    def test_wait_for_event_raises_parked(self, fresh_runtime):
        _host_recorder(
            fresh_runtime,
            {"bots.waitForEvent": {"status": "parked", "stepName": "ci", "resumeAt": 7}},
        )
        run = bot_run(cognia.ctx, SNAPSHOT)
        with pytest.raises(BotRunParked):
            asyncio.run(run.wait_for_event("ci", "key-1", 60_000))

    def test_log_and_progress_forward(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime)
        run = bot_run(cognia.ctx, SNAPSHOT)

        async def main():
            await run.log("info", "fetched", {"count": 3})
            await run.progress(fraction=0.5, message="halfway")

        asyncio.run(main())
        assert calls == [
            ("bots.log", {"args": ["run_1", "info", "fetched", {"count": 3}]}),
            ("bots.progress", {"args": ["run_1", {"fraction": 0.5, "message": "halfway"}]}),
        ]

    def test_log_rejects_an_unknown_level(self, fresh_runtime):
        run = bot_run(cognia.ctx, SNAPSHOT)
        with pytest.raises(ValueError, match="log level"):
            asyncio.run(run.log("verbose", "nope"))

    def test_get_installation_wraps_the_host_call(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime, {"bots.getInstallation": {"id": "inst_1"}})
        run = bot_run(cognia.ctx, SNAPSHOT)
        assert asyncio.run(run.get_installation()) == {"id": "inst_1"}
        assert calls == [("bots.getInstallation", {"args": ["run_1"]})]

    def test_write_trigger_state_omits_none_keys(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime)
        run = bot_run(cognia.ctx, SNAPSHOT)

        async def main():
            await run.write_trigger_state("poll-1", cursor="c-9")
            await run.write_trigger_state("poll-1", watermark=41.0)

        asyncio.run(main())
        assert calls == [
            ("bots.writeTriggerState", {"args": ["run_1", {"triggerId": "poll-1", "cursor": "c-9"}]}),
            ("bots.writeTriggerState", {"args": ["run_1", {"triggerId": "poll-1", "watermark": 41.0}]}),
        ]

    def test_set_trigger_armed_forwards_the_boolean(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime)
        run = bot_run(cognia.ctx, SNAPSHOT)
        asyncio.run(run.set_trigger_armed("nightly", False))
        assert calls == [
            ("bots.setTriggerArmed", {"args": ["run_1", {"triggerId": "nightly", "armed": False}]})
        ]

    def test_list_deliveries_builds_the_query(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime, {"bots.listDeliveries": [{"id": "bdl_1"}]})
        run = bot_run(cognia.ctx, SNAPSHOT)
        result = asyncio.run(
            run.list_deliveries(
                resource_id="repo:1", trigger_id="poll-1", status=["pending", "failed"], limit=10
            )
        )
        assert result == [{"id": "bdl_1"}]
        assert calls == [
            (
                "bots.listDeliveries",
                {
                    "args": [
                        "run_1",
                        {
                            "resourceId": "repo:1",
                            "triggerId": "poll-1",
                            "status": ["pending", "failed"],
                            "limit": 10,
                        },
                    ]
                },
            )
        ]

    def test_list_deliveries_defaults_to_an_empty_query(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime, {"bots.listDeliveries": []})
        run = bot_run(cognia.ctx, SNAPSHOT)
        asyncio.run(run.list_deliveries())
        assert calls == [("bots.listDeliveries", {"args": ["run_1", {}]})]

    def test_get_run_result_forwards_the_target(self, fresh_runtime):
        calls = _host_recorder(
            fresh_runtime, {"bots.getRunResult": {"status": "completed", "summary": "done"}}
        )
        run = bot_run(cognia.ctx, SNAPSHOT)
        assert asyncio.run(run.get_run_result("run_2")) == {
            "status": "completed",
            "summary": "done",
        }
        assert calls == [("bots.getRunResult", {"args": ["run_1", {"runId": "run_2"}]})]

    def test_emit_omits_a_missing_resource(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime, {"bots.emit": {"matchedInstallations": 2}})
        run = bot_run(cognia.ctx, SNAPSHOT)
        assert asyncio.run(run.emit("acme.review.ready", {"pr": 7})) == {
            "matchedInstallations": 2
        }
        assert calls == [
            ("bots.emit", {"args": ["run_1", {"type": "acme.review.ready", "payload": {"pr": 7}}]})
        ]

    def test_emit_includes_a_resource(self, fresh_runtime):
        calls = _host_recorder(fresh_runtime, {"bots.emit": {"matchedInstallations": 1}})
        run = bot_run(cognia.ctx, SNAPSHOT)
        asyncio.run(
            run.emit("acme.review.ready", {"pr": 7}, resource={"kind": "pr", "id": "7"})
        )
        assert calls == [
            (
                "bots.emit",
                {
                    "args": [
                        "run_1",
                        {
                            "type": "acme.review.ready",
                            "payload": {"pr": 7},
                            "resource": {"kind": "pr", "id": "7"},
                        },
                    ]
                },
            )
        ]


class TestDispatcherWrap:
    def test_run_gets_a_bot_run_when_the_contribution_is_a_bot(self, fresh_runtime):
        define_bot(
            id="digest",
            name="Digest",
            version="1.0.0",
            executor="handler",
            triggers=[{"id": "m", "kind": "manual"}],
        )
        seen = {}

        @cognia.contribution("digest")
        class Digest:
            async def run(self, snapshot):
                seen["snapshot"] = snapshot
                return {"summary": "done"}

        result = fresh_runtime.dispatch_contribution("digest", "run", [dict(SNAPSHOT)])
        assert asyncio.run(result) == {"summary": "done"}
        assert isinstance(seen["snapshot"], BotRun)
        assert seen["snapshot"].run_id == "run_1"

    def test_run_stays_raw_for_a_non_bot_contribution(self, fresh_runtime):
        seen = {}

        @cognia.contribution("tesseract")
        class Tesseract:
            async def run(self, snapshot):
                seen["snapshot"] = snapshot

        result = fresh_runtime.dispatch_contribution("tesseract", "run", [dict(SNAPSHOT)])
        asyncio.run(result)
        assert not isinstance(seen["snapshot"], BotRun)
        assert seen["snapshot"]["runId"] == "run_1"


class TestLifecycle:
    def _bot(self, lifecycle=None):
        return define_bot(
            id="digest",
            name="Digest",
            version="1.0.0",
            executor="handler",
            triggers=[{"id": "m", "kind": "manual"}],
            lifecycle=lifecycle,
        )

    def test_lifecycle_emits_in_manifest(self):
        bot = self._bot({"hooks": ["onInstall", "onUninstall"]})
        assert bot.to_dict()["lifecycle"] == {"hooks": ["onInstall", "onUninstall"]}

    def test_lifecycle_omitted_when_absent(self):
        assert "lifecycle" not in self._bot().to_dict()

    def test_rejects_empty_hooks(self):
        with pytest.raises(ValueError, match="at least one hook"):
            self._bot({"hooks": []})

    def test_rejects_unknown_hook(self):
        with pytest.raises(ValueError, match="unknown hook"):
            self._bot({"hooks": ["onBoot"]})

    def test_rejects_duplicate_hooks(self):
        with pytest.raises(ValueError, match="twice"):
            self._bot({"hooks": ["onArm", "onArm"]})

    def test_rejects_non_mapping_lifecycle(self):
        with pytest.raises(ValueError, match="must be an object"):
            self._bot([("hooks", ["onInstall"])])

    def test_rejects_non_string_entry(self):
        with pytest.raises(ValueError, match="'lifecycle.entry' must be a string"):
            self._bot({"hooks": ["onInstall"], "entry": 4})

    def test_dispatch_maps_camel_case_to_snake_case(self, fresh_runtime):
        self._bot({"hooks": ["onInstall", "onArm"]})
        seen = {}

        @cognia.contribution("digest")
        class Digest:
            async def on_install(self, ctx):
                seen["on_install"] = ctx
                return None

            async def on_arm(self, ctx):
                seen["on_arm"] = ctx
                return None

        lifecycle_ctx = {"installation": {"id": "boti_1"}, "trigger": {"id": "m", "armed": False}}
        asyncio.run(
            fresh_runtime.dispatch_contribution("digest", "onInstall", [lifecycle_ctx])
        )
        asyncio.run(
            fresh_runtime.dispatch_contribution("digest", "onArm", [lifecycle_ctx])
        )
        # The ctx dict passes through unchanged.
        assert seen["on_install"] is lifecycle_ctx
        assert seen["on_arm"] is lifecycle_ctx

    def test_camel_case_hook_does_not_map_for_non_bot(self, fresh_runtime):
        @cognia.contribution("tesseract")
        class Tesseract:
            async def on_install(self, ctx):
                return "should not be reached"

        with pytest.raises(RuntimeError, match="has no method 'onInstall'"):
            asyncio.run(
                fresh_runtime.dispatch_contribution("tesseract", "onInstall", [{}])
            )
