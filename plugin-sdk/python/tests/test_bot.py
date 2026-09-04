"""Bot capability: manifest declaration and durable-step sugar."""

from __future__ import annotations

import pytest

import cognia
from cognia.bot import define_bot


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
                {"id": "d", "kind": "derivedState", "everyMs": 1000},
                "needs a 'state'",
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

    def test_is_exported_from_the_package_root(self):
        assert cognia.define_bot is define_bot
        assert cognia.BOT_EXECUTORS == ("workflow", "squad", "agent-turn", "handler")
