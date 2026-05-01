/**
 * A2UI Data Templates
 * Templates for charts, dashboards, and data visualization
 */

import type { A2UIComponent } from "@/types/a2ui/schema"
import type { A2UIAppTemplate } from "./types"

/**
 * Data Dashboard Template
 */
export const dataDashboardTemplate: A2UIAppTemplate = {
  id: "data-dashboard",
  name: "Data Dashboard",
  description: "A dashboard displaying charts and statistics",
  icon: "BarChart3",
  category: "data",
  tags: ["dashboard", "analytics", "charts", "data"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "stats-row", "chart-section", "table-section"],
      className: "gap-4 p-4",
    },
    {
      id: "header",
      component: "Row",
      children: ["title", "refresh-btn"],
      className: "justify-between items-center",
    },
    { id: "title", component: "Text", text: "📊 Analytics Dashboard", variant: "heading2" },
    {
      id: "refresh-btn",
      component: "Button",
      text: "Refresh",
      action: "refresh_data",
      variant: "outline",
      icon: "RefreshCw",
    },
    {
      id: "stats-row",
      component: "Row",
      children: ["stat-users", "stat-revenue", "stat-growth"],
      className: "gap-4",
    },
    {
      id: "stat-users",
      component: "Card",
      title: "Total Users",
      children: ["users-value"],
      className: "flex-1",
    },
    {
      id: "users-value",
      component: "Text",
      text: { path: "/stats/users" },
      variant: "heading1",
      color: "primary",
    },
    {
      id: "stat-revenue",
      component: "Card",
      title: "Revenue",
      children: ["revenue-value"],
      className: "flex-1",
    },
    {
      id: "revenue-value",
      component: "Text",
      text: { path: "/stats/revenue" },
      variant: "heading1",
      color: "primary",
    },
    {
      id: "stat-growth",
      component: "Card",
      title: "Growth",
      children: ["growth-value"],
      className: "flex-1",
    },
    {
      id: "growth-value",
      component: "Text",
      text: { path: "/stats/growth" },
      variant: "heading1",
      color: "primary",
    },
    { id: "chart-section", component: "Card", title: "Monthly Trends", children: ["main-chart"] },
    {
      id: "main-chart",
      component: "Chart",
      chartType: "area",
      data: { path: "/chartData" },
      xKey: "month",
      yKeys: ["users", "revenue"],
      height: 250,
      showLegend: true,
      showGrid: true,
    },
    {
      id: "table-section",
      component: "Card",
      title: "Recent Activity",
      children: ["activity-table"],
    },
    {
      id: "activity-table",
      component: "Table",
      columns: [
        { key: "date", header: "Date", type: "date" },
        { key: "event", header: "Event" },
        { key: "user", header: "User" },
        { key: "value", header: "Value", type: "number", align: "right" },
      ],
      data: { path: "/activityData" },
      pagination: true,
      pageSize: 5,
      rowClickAction: "view_activity",
    },
  ] as A2UIComponent[],
  dataModel: {
    stats: {
      users: "12,450",
      revenue: "$45,230",
      growth: "+23%",
    },
    chartData: [
      { month: "Jan", users: 1200, revenue: 5000 },
      { month: "Feb", users: 1400, revenue: 6200 },
      { month: "Mar", users: 1800, revenue: 7800 },
      { month: "Apr", users: 2100, revenue: 8500 },
      { month: "May", users: 2500, revenue: 9200 },
      { month: "Jun", users: 2800, revenue: 10500 },
    ],
    activityData: [
      { id: 1, date: "2024-01-15", event: "New signup", user: "John Doe", value: 1 },
      { id: 2, date: "2024-01-15", event: "Purchase", user: "Jane Smith", value: 99 },
      { id: 3, date: "2024-01-14", event: "Upgrade", user: "Bob Wilson", value: 49 },
    ],
  },
}

/**
 * Expense Tracker Template
 */
export const expenseTrackerTemplate: A2UIAppTemplate = {
  id: "expense-tracker",
  name: "Expense Tracker",
  description: "Track your daily expenses and budget",
  icon: "Wallet",
  category: "data",
  tags: ["expenses", "money", "budget", "finance", "tracking"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "summary-row", "add-card", "expenses-list"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "💰 Expense Tracker", variant: "heading2" },
    {
      id: "summary-row",
      component: "Row",
      children: ["total-card", "today-card"],
      className: "gap-4",
    },
    {
      id: "total-card",
      component: "Card",
      children: ["total-label", "total-value"],
      className: "flex-1 p-4 text-center",
    },
    { id: "total-label", component: "Text", text: "Total Spent", variant: "caption" },
    {
      id: "total-value",
      component: "Text",
      text: { path: "/stats/totalText" },
      variant: "heading2",
      color: "primary",
    },
    {
      id: "today-card",
      component: "Card",
      children: ["today-label", "today-value"],
      className: "flex-1 p-4 text-center",
    },
    { id: "today-label", component: "Text", text: "Today", variant: "caption" },
    {
      id: "today-value",
      component: "Text",
      text: { path: "/stats/todayText" },
      variant: "heading2",
    },
    {
      id: "add-card",
      component: "Card",
      children: ["expense-input-row", "category-row", "add-btn"],
      className: "p-4",
    },
    {
      id: "expense-input-row",
      component: "Row",
      children: ["desc-input", "amount-input"],
      className: "gap-2",
    },
    {
      id: "desc-input",
      component: "TextField",
      value: { path: "/newExpense/description" },
      placeholder: "Description...",
      label: "What",
      className: "flex-1",
    },
    {
      id: "amount-input",
      component: "TextField",
      value: { path: "/newExpense/amount" },
      placeholder: "0.00",
      type: "number",
      label: "Amount",
      className: "w-24",
    },
    {
      id: "category-row",
      component: "Select",
      value: { path: "/newExpense/category" },
      label: "Category",
      options: [
        { value: "food", label: "🍔 Food" },
        { value: "transport", label: "🚗 Transport" },
        { value: "shopping", label: "🛍️ Shopping" },
        { value: "entertainment", label: "🎬 Entertainment" },
        { value: "other", label: "📦 Other" },
      ],
    },
    {
      id: "add-btn",
      component: "Button",
      text: "Add Expense",
      action: "add_expense",
      variant: "primary",
      className: "mt-2 w-full",
    },
    {
      id: "expenses-list",
      component: "List",
      items: { path: "/expenses" },
      emptyText: "No expenses recorded",
      dividers: true,
    },
  ] as A2UIComponent[],
  dataModel: {
    newExpense: { description: "", amount: "", category: "food" },
    expenses: [],
    stats: {
      total: 0,
      totalText: "$0.00",
      today: 0,
      todayText: "$0.00",
    },
  },
}
