---
"cognia-next": minor
---

Issues and Projects: a board you can actually drag on, and an issue you can actually edit.

**Dragging a card works.** It used to disappear at the edge of its column and, when you could see it, sat behind the columns you were dragging past. Two separate causes: the card was being moved in place inside a scrolling container, which clipped it, and the greyed-out "you can't drop here" columns were painting on top of it. The card now floats above the board and follows the cursor, a line marks exactly where it will land, and the board scrolls sideways when you carry a card to the edge. The Agent Team task board had the identical bug and is fixed too. You can also drag with the keyboard now — Space picks a card up, the arrows move it, Enter still opens one.

**The Issues page has a sidebar.** Views, projects and labels moved out of the header, which had grown into a single row so crowded that on a narrow window its right-hand half silently scrolled off the edge. Clicking a project or a label filters the board in place. Above the board, every filter you have on is now spelled out as a chip you can take off one at a time — previously the only evidence was a number on a closed menu.

**Issues are editable.** Renaming, re-describing, re-prioritising, labelling, moving between projects, commenting and deleting were all built but unreachable — an issue was frozen the moment you created it. All of them now work, from the inspector, from a right-click on any row or card, and across a multi-row selection. Every action honestly disables itself on rows it can't touch (a GitHub mirror, an agent task) instead of failing after you click, and a bulk edit tells you how many rows it actually changed rather than claiming them all.

**Labels render at all.** No label chip could appear anywhere in the tracker: local issues could never be given one, and GitHub's labels showed up in the filter menu as the raw string `github:bug`. Issue labels now have a proper catalogue you can create, rename, recolour, reorder and delete, and GitHub's own labels display with their names.

**Projects is a real console.** It was a grid of cards that could show a name, a key and a progress bar — the lead, the target date and the issue count were all invisible, and nothing on the page could be changed. Worse, a workspace could only ever have one project, because the only way to create one was as a side effect of filing your very first issue. It is now a table with every field visible, an inspector that edits all of them, a create button, and a delete that tells you how many issues go with it.

**The board remembers.** Your filter, layout, grouping, sort, density and which columns you've collapsed now survive leaving the page, and are kept separately per view. Empty columns fold into a narrow strip you can still drop onto, so six columns fit on a laptop instead of always scrolling.

On phones, both pages stay read-only, but a deep link to an issue now opens it instead of just tinting a row, and Projects has a mobile layout at all.
