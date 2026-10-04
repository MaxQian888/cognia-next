"""Tests for cognia.pet manifest mirrors.

The rules are the host's (``lib/plugin/registries/pet-contribution-validation.ts``);
an entry that fails them is dropped when the plugin is enabled, so the helpers
refuse it at authoring time.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from cognia import define_pet_achievement, define_pet_item
from cognia.pet import MAX_PET_ITEM_PRICE, PET_EVENT_KINDS


# -- pet-item ---------------------------------------------------------------


def test_pet_item_minimal_and_full():
    it = define_pet_item("lamp", {"en": "Lamp"}, "decor", 10, False)
    assert it.to_dict() == {
        "id": "lamp",
        "labels": {"en": "Lamp"},
        "category": "decor",
        "price": 10,
        "consumable": False,
    }
    full = define_pet_item(
        "ball",
        {"en": "Ball", "zh-CN": "球"},
        "toy",
        20,
        True,
        descriptions={"en": "A bouncy ball"},
        icon="Volleyball",
        interaction_kind="played",
        needs_effect={"mood": 5, "energy": -2},
    )
    d = full.to_dict()
    assert d["descriptions"] == {"en": "A bouncy ball"} and d["icon"] == "Volleyball"
    assert d["interactionKind"] == "played"
    assert d["needsEffect"] == {"mood": 5, "energy": -2}


def test_pet_item_accepts_the_legacy_kebab_icon_spelling():
    assert define_pet_item("lamp", {"en": "Lamp"}, "decor", 10, False, icon="lamp-desk").icon


def test_pet_item_validations():
    with pytest.raises(ValueError, match="labels"):
        define_pet_item("i", {}, "food", 1, True, interaction_kind="fed")
    with pytest.raises(ValueError, match="English"):
        define_pet_item("i", {"zh-CN": "饼干"}, "food", 1, True, interaction_kind="fed")
    with pytest.raises(ValueError, match="category"):
        define_pet_item("i", {"en": "x"}, "weapon", 1, True, interaction_kind="fed")
    with pytest.raises(ValueError, match="interaction_kind"):
        define_pet_item("i", {"en": "x"}, "food", 1, True, interaction_kind="hugged")
    with pytest.raises(ValueError, match="id"):
        define_pet_item("has space", {"en": "x"}, "decor", 1, False)


@pytest.mark.parametrize("price", [0, -1, 2.5, True, MAX_PET_ITEM_PRICE + 1])
def test_pet_item_rejects_bad_prices(price):
    with pytest.raises(ValueError, match="price"):
        define_pet_item("i", {"en": "x"}, "decor", price, False)


def test_pet_item_consumable_needs_its_interaction():
    with pytest.raises(ValueError, match="interaction_kind"):
        define_pet_item("snack", {"en": "Snack"}, "food", 5, True)


def test_pet_item_needs_effect_rules():
    with pytest.raises(ValueError, match="consumable"):
        define_pet_item("lamp", {"en": "Lamp"}, "decor", 5, False, needs_effect={"mood": 3})
    with pytest.raises(ValueError, match="not a need"):
        define_pet_item(
            "s", {"en": "S"}, "food", 5, True, interaction_kind="fed", needs_effect={"hunger": 3}
        )
    with pytest.raises(ValueError, match="needs_effect"):
        define_pet_item(
            "s", {"en": "S"}, "food", 5, True, interaction_kind="fed", needs_effect={"energy": 500}
        )


def test_pet_item_rejects_an_emoji_icon():
    with pytest.raises(ValueError, match="icon"):
        define_pet_item("ball", {"en": "Ball"}, "toy", 5, False, icon="🎾")


# -- pet-achievement --------------------------------------------------------


def test_pet_achievement_minimal_and_full():
    a = define_pet_achievement(
        "first-feed", {"en": "First Feed"}, {"type": "counter", "kind": "fed", "gte": 1}
    )
    assert a.to_dict() == {
        "id": "first-feed",
        "labels": {"en": "First Feed"},
        "condition": {"type": "counter", "kind": "fed", "gte": 1},
    }
    full = define_pet_achievement(
        "bond",
        {"en": "Best Friends"},
        {"type": "need", "need": "bond", "gte": 100},
        descriptions={"en": "Reach max bond"},
        icon="Heart",
    )
    d = full.to_dict()
    assert d["descriptions"] == {"en": "Reach max bond"} and d["icon"] == "Heart"
    assert define_pet_achievement("lvl", {"en": "L"}, {"type": "level", "gte": 10}).condition


def test_pet_achievement_validations():
    with pytest.raises(ValueError, match="labels"):
        define_pet_achievement("i", {}, {"type": "level", "gte": 1})
    with pytest.raises(ValueError, match="condition"):
        define_pet_achievement("i", {"en": "x"}, {})
    with pytest.raises(ValueError, match="condition type"):
        define_pet_achievement("i", {"en": "x"}, {"type": "feedCount", "gte": 1})
    with pytest.raises(ValueError, match="gte"):
        define_pet_achievement("i", {"en": "x"}, {"type": "level", "gte": -1})
    with pytest.raises(ValueError, match="gte"):
        define_pet_achievement("i", {"en": "x"}, {"type": "level"})
    with pytest.raises(ValueError, match="exceed 100"):
        define_pet_achievement("i", {"en": "x"}, {"type": "need", "need": "mood", "gte": 150})
    with pytest.raises(ValueError, match="need"):
        define_pet_achievement("i", {"en": "x"}, {"type": "need", "need": "hunger", "gte": 5})
    with pytest.raises(ValueError, match="icon"):
        define_pet_achievement("i", {"en": "x"}, {"type": "level", "gte": 1}, icon="💛")


def test_counter_on_a_kind_the_ledger_never_records_is_refused():
    # It would register and never unlock.
    with pytest.raises(ValueError, match="pet event kind"):
        define_pet_achievement(
            "quest-master", {"en": "Quest master"}, {"type": "counter", "kind": "quest.completed", "gte": 3}
        )


def _repo_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / "types" / "pet" / "events.ts").exists():
            return parent
    return None


def test_event_kinds_match_the_host_list():
    root = _repo_root()
    if root is None:
        pytest.skip("host source not reachable (standalone SDK checkout)")
    source = (root / "types" / "pet" / "events.ts").read_text(encoding="utf-8")
    block = source.split("export const PET_EVENT_KINDS = [", 1)[1].split("] as const", 1)[0]
    host = set(re.findall(r'^\s*"([A-Za-z]+)",', block, re.M))
    assert host == set(PET_EVENT_KINDS)
