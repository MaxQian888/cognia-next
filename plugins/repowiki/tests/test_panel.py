"""The reader panel's component tree.

The panel is data, so its layout is testable without a browser. What these pin
is mostly the set of ways a component tree can be *almost* right and render as
nothing: a missing `root`, a child id nothing declares, a page whose parent was
dropped.
"""

from __future__ import annotations

from repowiki.panel import (
    ACTION_OPEN_CITATION,
    ACTION_OPEN_PAGE,
    ACTION_RESCAN,
    ACTION_SELECT_PROJECT,
    build_panel,
    surface_id_for,
)

PAGES = [
    {"id": "index", "title": "Overview", "parentId": "", "content": "# Overview"},
    {"id": "modules", "title": "Modules", "parentId": "", "content": "# Modules"},
    {"id": "modules/core", "title": "core", "parentId": "modules", "content": "# core"},
    {"id": "modules/api", "title": "api", "parentId": "modules", "content": "# api"},
]


def _by_id(components):
    return {component["id"]: component for component in components}


def _panel(**over):
    args = {"project_name": "Demo", "pages": PAGES, "active_page": PAGES[0]}
    args.update(over)
    return build_panel(**args)


def test_surface_id_is_the_prefix_and_the_resource_key():
    assert surface_id_for("cognia-repowiki", "session:s1") == "cognia-repowiki:session:s1"


def test_the_tree_has_a_root_and_every_child_reference_resolves():
    # A surface whose root is missing renders its "no content" state, and a
    # dangling child id renders a fallback box — both look like a broken panel
    # rather than a broken tree.
    components = _panel()
    by_id = _by_id(components)
    assert "root" in by_id
    for component in components:
        for child_id in component.get("children") or []:
            assert child_id in by_id, f"{component['id']} points at missing {child_id}"


def test_pages_nest_by_parent_id():
    outline = _by_id(_panel())["outline"]
    labels = [node["label"] for node in outline["nodes"]]
    assert labels == ["Overview", "Modules"]
    modules = next(node for node in outline["nodes"] if node["label"] == "Modules")
    assert [child["label"] for child in modules["children"]] == ["core", "api"]


def test_a_page_whose_parent_is_missing_still_appears():
    # Dropping it would make a page unreachable with no signal that it exists.
    orphan = [{"id": "stray", "title": "Stray", "parentId": "gone", "content": "x"}]
    outline = _by_id(_panel(pages=orphan, active_page=orphan[0]))["outline"]
    assert [node["label"] for node in outline["nodes"]] == ["Stray"]


def test_the_outline_reports_selection_and_the_body_carries_the_page():
    components = _by_id(_panel(active_page=PAGES[2]))
    assert components["outline"]["selectedId"] == "modules/core"
    assert components["page"]["content"] == "# core"
    assert components["outline"]["action"] == ACTION_OPEN_PAGE


def test_citations_route_to_the_plugin_rather_than_the_hosts_default():
    # The host would have to guess what a relative path in generated prose
    # means; the plugin knows, because it holds the checkout root.
    page = _by_id(_panel(project_root="/repo"))["page"]
    assert page["openFileAction"] == ACTION_OPEN_CITATION
    assert page["projectRoot"] == "/repo"


def test_an_unscanned_panel_says_so_in_both_halves():
    components = _by_id(_panel(pages=[], active_page=None, empty_label="Nothing yet"))
    assert components["outline"]["nodes"] == []
    assert components["outline"]["emptyLabel"] == "Nothing yet"
    assert "Nothing yet" in components["page"]["content"]


def test_the_repository_picker_appears_only_with_something_to_pick():
    assert "project-picker" not in _by_id(_panel())
    picked = _by_id(
        _panel(projects=[{"projectId": "a", "projectName": "A"}, {"projectId": "b"}])
    )
    assert picked["project-picker"]["action"] == ACTION_SELECT_PROJECT
    # A project with no name falls back to its id rather than an empty row.
    assert picked["project-picker"]["options"][1]["label"] == "b"
    assert "project-picker" in _by_id(_panel(projects=[{"projectId": "a"}]))["header"]["children"]


def test_staleness_brings_its_own_way_out():
    # A badge that says "out of date" with no way to act on it is a complaint.
    components = _by_id(_panel(stale=True))
    assert components["stale"]["variant"] == "destructive"
    assert components["rescan"]["action"] == ACTION_RESCAN
    assert components["header"]["children"][-2:] == ["stale", "rescan"]


def test_warnings_sit_between_the_header_and_the_body_as_one_banner():
    components = _panel(warnings=["a truncated walk", "2 files withheld"])
    by_id = _by_id(components)
    assert by_id["root"]["children"] == ["header", "warnings", "body"]
    # One Alert, not one per warning: a stack of banners pushes the page off
    # screen, and the header is not a place an Alert can be read.
    assert "warnings" not in by_id["header"]["children"]
    assert by_id["warnings"]["message"] == "a truncated walk · 2 files withheld"


def test_every_component_is_json_shaped_because_it_crosses_the_wire():
    import json

    json.dumps(_panel(stale=True, warnings=["x"], projects=[{"projectId": "a"}]))
