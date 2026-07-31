"""Tests for cognia.pet manifest mirrors."""

from __future__ import annotations

import pytest

from cognia import define_pet_achievement, define_pet_item


# -- pet-item ---------------------------------------------------------------


def test_pet_item_minimal_and_full():
    it = define_pet_item("apple", {"en": "Apple"}, "food", 10, True)
    assert it.to_dict() == {
        "id": "apple",
        "labels": {"en": "Apple"},
        "category": "food",
        "price": 10,
        "consumable": True,
    }
    full = define_pet_item(
        "ball",
        {"en": "Ball", "zh-CN": "球"},
        "toy",
        20,
        False,
        descriptions={"en": "A bouncy ball"},
        icon="🎾",
        interaction_kind="played",
        needs_effect={"mood": 5, "energy": -2},
    )
    d = full.to_dict()
    assert d["descriptions"] == {"en": "A bouncy ball"} and d["icon"] == "🎾"
    assert d["interactionKind"] == "played"
    assert d["needsEffect"] == {"mood": 5, "energy": -2}


def test_pet_item_validations():
    with pytest.raises(ValueError, match="labels"):
        define_pet_item("i", {}, "food", 1, True)
    with pytest.raises(ValueError, match="category"):
        define_pet_item("i", {"en": "x"}, "weapon", 1, True)
    with pytest.raises(ValueError, match="interaction_kind"):
        define_pet_item("i", {"en": "x"}, "food", 1, True, interaction_kind="hugged")


# -- pet-achievement --------------------------------------------------------


def test_pet_achievement_minimal_and_full():
    a = define_pet_achievement("first-feed", {"en": "First Feed"}, {"kind": "feedCount", "count": 1})
    assert a.to_dict() == {
        "id": "first-feed",
        "labels": {"en": "First Feed"},
        "condition": {"kind": "feedCount", "count": 1},
    }
    full = define_pet_achievement(
        "bond",
        {"en": "Best Friends"},
        {"kind": "bond", "threshold": 100},
        descriptions={"en": "Reach max bond"},
        icon="💛",
    )
    d = full.to_dict()
    assert d["descriptions"] == {"en": "Reach max bond"} and d["icon"] == "💛"


def test_pet_achievement_validations():
    with pytest.raises(ValueError, match="labels"):
        define_pet_achievement("i", {}, {"kind": "x"})
    with pytest.raises(ValueError, match="condition"):
        define_pet_achievement("i", {"en": "x"}, {})
