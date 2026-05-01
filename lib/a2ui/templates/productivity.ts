/**
 * A2UI Productivity Templates
 * Templates for task management and organization apps
 */

import type { A2UIComponent } from "@/types/a2ui/schema"
import type { A2UIAppTemplate } from "./types"

/**
 * Todo List App Template
 */
export const todoListTemplate: A2UIAppTemplate = {
  id: "todo-list",
  name: "Todo List",
  description: "A simple task management app with add, complete, and delete functionality",
  icon: "CheckSquare",
  category: "productivity",
  tags: ["tasks", "productivity", "list"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "input-row", "task-list", "stats"],
      className: "gap-4 p-4",
    },
    {
      id: "header",
      component: "Text",
      text: "📝 My Tasks",
      variant: "heading2",
    },
    {
      id: "input-row",
      component: "Row",
      children: ["task-input", "add-btn"],
      className: "gap-2",
    },
    {
      id: "task-input",
      component: "TextField",
      value: { path: "/newTask" },
      placeholder: "Enter a new task...",
      className: "flex-1",
    },
    {
      id: "add-btn",
      component: "Button",
      text: "Add",
      action: "add_task",
      variant: "primary",
      icon: "Plus",
    },
    {
      id: "task-list",
      component: "List",
      items: { path: "/tasks" },
      emptyText: "No tasks yet. Add one above!",
      itemClickAction: "toggle_task",
      dividers: true,
    },
    {
      id: "stats",
      component: "Row",
      children: ["completed-badge", "pending-badge"],
      className: "gap-2 justify-center",
    },
    {
      id: "completed-badge",
      component: "Badge",
      text: { path: "/stats/completedText" },
      variant: "secondary",
    },
    {
      id: "pending-badge",
      component: "Badge",
      text: { path: "/stats/pendingText" },
      variant: "outline",
    },
  ] as A2UIComponent[],
  dataModel: {
    newTask: "",
    tasks: [],
    stats: {
      completed: 0,
      pending: 0,
      completedText: "0 completed",
      pendingText: "0 pending",
    },
  },
}

/**
 * Notes App Template
 */
export const notesTemplate: A2UIAppTemplate = {
  id: "notes",
  name: "Quick Notes",
  description: "A simple note-taking app with search",
  icon: "StickyNote",
  category: "productivity",
  tags: ["notes", "writing", "productivity"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "search-row", "new-note-card", "notes-list"],
      className: "gap-4 p-4",
    },
    {
      id: "header",
      component: "Text",
      text: "📝 Quick Notes",
      variant: "heading2",
    },
    {
      id: "search-row",
      component: "TextField",
      value: { path: "/searchQuery" },
      placeholder: "🔍 Search notes...",
      className: "w-full",
    },
    {
      id: "new-note-card",
      component: "Card",
      children: ["note-title-input", "note-content-input", "save-btn"],
      className: "p-4",
    },
    {
      id: "note-title-input",
      component: "TextField",
      value: { path: "/newNote/title" },
      placeholder: "Note title",
      label: "Title",
    },
    {
      id: "note-content-input",
      component: "TextArea",
      value: { path: "/newNote/content" },
      placeholder: "Write your note here...",
      rows: 3,
    },
    {
      id: "save-btn",
      component: "Button",
      text: "Save Note",
      action: "save_note",
      variant: "primary",
      icon: "Save",
      className: "mt-2",
    },
    {
      id: "notes-list",
      component: "Column",
      children: ["notes-label"],
      className: "gap-2",
    },
    {
      id: "notes-label",
      component: "Text",
      text: { path: "/notesCountText" },
      variant: "caption",
    },
  ] as A2UIComponent[],
  dataModel: {
    searchQuery: "",
    newNote: {
      title: "",
      content: "",
    },
    notes: [],
    notesCountText: "0 notes",
  },
}

/**
 * Habit Tracker Template
 */
export const habitTrackerTemplate: A2UIAppTemplate = {
  id: "habit-tracker",
  name: "Habit Tracker",
  description: "Track your daily habits and build streaks",
  icon: "Target",
  category: "productivity",
  tags: ["habits", "tracking", "daily", "goals", "productivity"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "add-row", "habits-list", "stats-row"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "🎯 Habit Tracker", variant: "heading2" },
    { id: "add-row", component: "Row", children: ["habit-input", "add-btn"], className: "gap-2" },
    {
      id: "habit-input",
      component: "TextField",
      value: { path: "/newHabit" },
      placeholder: "New habit...",
      className: "flex-1",
    },
    {
      id: "add-btn",
      component: "Button",
      text: "Add",
      action: "add_habit",
      variant: "primary",
      icon: "Plus",
    },
    {
      id: "habits-list",
      component: "List",
      items: { path: "/habits" },
      emptyText: "No habits yet. Add one above!",
      itemClickAction: "toggle_habit",
      dividers: true,
    },
    {
      id: "stats-row",
      component: "Row",
      children: ["streak-badge", "completed-badge"],
      className: "gap-2 justify-center",
    },
    {
      id: "streak-badge",
      component: "Badge",
      text: { path: "/stats/streakText" },
      variant: "default",
    },
    {
      id: "completed-badge",
      component: "Badge",
      text: { path: "/stats/todayText" },
      variant: "secondary",
    },
  ] as A2UIComponent[],
  dataModel: {
    newHabit: "",
    habits: [],
    stats: {
      streak: 0,
      streakText: "0 day streak",
      todayCompleted: 0,
      todayText: "0 completed today",
    },
  },
}

/**
 * Shopping List Template
 */
export const shoppingListTemplate: A2UIAppTemplate = {
  id: "shopping-list",
  name: "Shopping List",
  description: "Simple grocery and shopping list manager",
  icon: "ShoppingCart",
  category: "productivity",
  tags: ["shopping", "grocery", "list", "productivity"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "add-section", "items-list", "total-row"],
      className: "gap-4 p-4",
    },
    {
      id: "header",
      component: "Row",
      children: ["title", "clear-btn"],
      className: "justify-between items-center",
    },
    { id: "title", component: "Text", text: "🛒 Shopping List", variant: "heading2" },
    {
      id: "clear-btn",
      component: "Button",
      text: "Clear All",
      action: "clear_list",
      variant: "ghost",
      icon: "Trash2",
    },
    {
      id: "add-section",
      component: "Row",
      children: ["item-input", "qty-input", "add-btn"],
      className: "gap-2",
    },
    {
      id: "item-input",
      component: "TextField",
      value: { path: "/newItem/name" },
      placeholder: "Item name...",
      className: "flex-1",
    },
    {
      id: "qty-input",
      component: "TextField",
      value: { path: "/newItem/quantity" },
      placeholder: "Qty",
      type: "number",
      className: "w-16",
    },
    {
      id: "add-btn",
      component: "Button",
      text: "Add",
      action: "add_item",
      variant: "primary",
      icon: "Plus",
    },
    {
      id: "items-list",
      component: "List",
      items: { path: "/items" },
      emptyText: "Your shopping list is empty",
      itemClickAction: "toggle_item",
      dividers: true,
    },
    { id: "total-row", component: "Card", children: ["total-text"], className: "p-3 text-center" },
    { id: "total-text", component: "Text", text: { path: "/totalText" }, variant: "body" },
  ] as A2UIComponent[],
  dataModel: {
    newItem: { name: "", quantity: 1 },
    items: [],
    totalText: "0 items",
  },
}
