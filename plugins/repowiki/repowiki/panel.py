"""The reader panel, as A2UI component data.

A Python plugin cannot hand the host a React component, so the panel is data:
a component tree pushed with ``ctx.a2ui.updateComponents``, rendered by the
host, with clicks coming back through the ``onA2UIAction`` hook. This module
builds that tree and nothing else — no host calls, no IO — so the layout is
unit-testable without a running app.

Two components carry it, both added to the A2UI catalog for this:

* ``Tree`` — the page outline at arbitrary depth. The catalog's only
  hierarchical navigator before was ``Sidebar``, fixed at two levels.
* ``Markdown`` — the page body, rendered by the same pipeline as a chat
  message, so Mermaid diagrams, syntax highlighting and the sanitize policy
  are shared rather than forked.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: Actions the panel emits. Namespaced because `onA2UIAction` is a broadcast:
#: every plugin's hook sees every surface's actions.
ACTION_OPEN_PAGE = "repowiki:open-page"
ACTION_OPEN_CITATION = "repowiki:open-citation"
ACTION_SELECT_PROJECT = "repowiki:select-project"
ACTION_RESCAN = "repowiki:rescan"


def surface_id_for(plugin_prefix: str, resource_key: str) -> str:
    """The surface a panel declaration resolves to for one resource."""
    return f"{plugin_prefix}:{resource_key}"


def _page_nodes(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fold the wiki's flat page list into the tree its parent ids describe.

    The builder emits pages with `parentId`, not a nested structure, because
    the sidebar and the page list are two views of the same thing upstream.
    Rebuilding the nesting here keeps that single source and means a page whose
    parent is missing still shows up — at the top level — rather than vanishing.
    """
    by_id = {page["id"]: page for page in pages}
    children: dict[str, list[dict[str, Any]]] = {}
    roots: list[dict[str, Any]] = []

    for page in pages:
        parent = page.get("parentId") or ""
        if parent and parent in by_id:
            children.setdefault(parent, []).append(page)
        else:
            roots.append(page)

    def node(page: dict[str, Any]) -> dict[str, Any]:
        built: dict[str, Any] = {
            "id": page["id"],
            "label": page.get("title") or page["id"],
            "icon": "file-text" if page.get("parentId") else "book-open",
        }
        kids = [node(child) for child in children.get(page["id"], [])]
        if kids:
            built["children"] = kids
            built["icon"] = "folder"
        return built

    return [node(page) for page in roots]


#: Every string the panel paints, with its English default.
#:
#: The panel builder stays pure — it takes the resolved text rather than
#: reaching for a translator — because it is also the unit under test, and a
#: layout test that needs a host attached is a layout test nobody runs. The
#: caller resolves these through ``ctx.i18n.t`` against the plugin's own
#: manifest bundle; anything it cannot resolve falls back to the value here.
DEFAULT_LABELS: dict[str, str] = {
    "panel.empty": "No wiki yet — run a scan to build one.",
    "panel.outOfDate": "Out of date",
    "panel.outOfDateCount": "Out of date · {count} changed",
    "panel.freshnessUnknown": "Freshness unknown",
    "panel.freshnessUnknownReason": "Freshness unknown: {reason}",
    "panel.rescan": "Rescan",
    "panel.partialScan": "Partial scan",
    "panel.snapshot": "Snapshot",
}


def build_panel(
    *,
    project_name: str,
    pages: list[dict[str, Any]],
    active_page: dict[str, Any] | None,
    project_root: str = "",
    staleness: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
    projects: list[dict[str, Any]] | None = None,
    live: bool = True,
    labels: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Return the component list for the reader surface.

    The root id must be ``"root"``: the host fixes it when the surface is
    created and no message changes it, so a tree without one renders the
    surface's "no content" state.
    """
    warnings = warnings or []
    projects = projects or []
    text = {**DEFAULT_LABELS, **(labels or {})}
    empty_label = text["panel.empty"]
    # Three states, not two. `known and not stale` is the only one that earns
    # silence; an unknown answer has to say so, because an absent badge is read
    # as "current" and that is precisely the claim we cannot make.
    known = bool((staleness or {}).get("known"))
    stale = known and bool((staleness or {}).get("stale"))
    unknown = staleness is not None and not known
    # A rehydrated wiki is a snapshot: it reads fine, but the checkout behind
    # it was released, so rescan is the way back to live files — offered even
    # when nothing reports stale.
    show_rescan = stale or unknown or not live
    # Why the check could not be answered goes in the banner, not on the badge.
    # A hover has no touch equivalent and A2UI has no tooltip field, so a
    # reason attached to the Badge would be a string nothing ever renders —
    # which is how a diagnostic becomes decoration.
    reason = str((staleness or {}).get("reason") or "").strip()
    if unknown and reason:
        warnings = [*warnings, text["panel.freshnessUnknownReason"].format(reason=reason)]

    root_children = ["header"]
    if warnings:
        root_children.append("warnings")
    root_children.append("body")

    components: list[dict[str, Any]] = [
        {
            "id": "root",
            "component": "Column",
            "children": root_children,
            "gap": 8,
        },
        {
            "id": "header",
            "component": "Row",
            "children": _header_children(projects, show_rescan, live, stale or unknown),
            "gap": 8,
            "align": "center",
        },
        {
            "id": "title",
            "component": "Text",
            "text": project_name or "RepoWiki",
            "variant": "heading4",
        },
        {
            "id": "body",
            "component": "Row",
            "children": ["outline", "page"],
            "gap": 12,
        },
        {
            "id": "outline",
            "component": "Tree",
            "nodes": _page_nodes(pages),
            "action": ACTION_OPEN_PAGE,
            "selectedId": (active_page or {}).get("id", ""),
            "defaultExpandedDepth": 1,
            "emptyLabel": empty_label,
            "weight": 1,
        },
        {
            "id": "page",
            "component": "Markdown",
            "content": (active_page or {}).get("content") or f"_{empty_label}_",
            # A citation is a workspace path: routing it to the plugin lets it
            # open the project editor at the line, rather than the host's
            # default guess about what a relative path in prose means.
            "openFileAction": ACTION_OPEN_CITATION,
            "projectRoot": project_root,
            "weight": 3,
        },
    ]

    if projects:
        components.append(
            {
                "id": "project-picker",
                "component": "Select",
                "value": (projects[0] if projects else {}).get("projectId", ""),
                "options": [
                    {
                        "value": entry.get("projectId", ""),
                        "label": entry.get("projectName") or entry.get("projectId", ""),
                    }
                    for entry in projects
                ],
                "action": ACTION_SELECT_PROJECT,
            }
        )
    if not live:
        components.append(
            {
                "id": "snapshot",
                "component": "Badge",
                "text": text["panel.snapshot"],
                "variant": "secondary",
            }
        )
    if stale or unknown:
        changed_count = int((staleness or {}).get("changedCount") or 0)
        components.append(
            {
                "id": "stale",
                "component": "Badge",
                "text": (
                    text["panel.outOfDateCount"].format(count=changed_count)
                    if stale and changed_count
                    else text["panel.outOfDate"]
                    if stale
                    else text["panel.freshnessUnknown"]
                ),
                "variant": "destructive" if stale else "secondary",
            }
        )
    if show_rescan:
        components.append(
            {
                "id": "rescan",
                "component": "Button",
                "text": text["panel.rescan"],
                "variant": "outline",
                "action": ACTION_RESCAN,
            }
        )
    if warnings:
        components.append(
            {
                "id": "warnings",
                "component": "Alert",
                "variant": "warning",
                "title": text["panel.partialScan"],
                # One alert, not one per warning: a stack of banners above the
                # page pushes the thing the user came to read off screen.
                "message": " · ".join(warnings),
            }
        )

    return components


def _header_children(
    projects: list[dict[str, Any]],
    show_rescan: bool,
    live: bool,
    has_freshness_badge: bool,
) -> list[str]:
    """Title, then the repository picker, then the state badges and rescan.

    Warnings are deliberately not here: an Alert wedged into a header Row next
    to a title is unreadable, so it sits between the header and the body where
    a banner belongs. The freshness badge is separate from rescan: a snapshot
    that checks out current earns no badge, only the way back to live files.
    """
    children = ["title"]
    if projects:
        children.append("project-picker")
    if not live:
        children.append("snapshot")
    if has_freshness_badge:
        children.append("stale")
    if show_rescan:
        children.append("rescan")
    return children
