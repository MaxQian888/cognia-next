/**
 * A2UI Utility Templates
 * Templates for handy tools and widgets
 */

import type { A2UIComponent } from "@/types/a2ui/schema"
import type { A2UIAppTemplate } from "./types"

/**
 * Calculator App Template
 */
export const calculatorTemplate: A2UIAppTemplate = {
  id: "calculator",
  name: "Calculator",
  description: "A basic calculator for arithmetic operations",
  icon: "Calculator",
  category: "utility",
  tags: ["math", "calculator", "utility"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["display", "buttons"],
      className: "gap-2 p-4 max-w-xs",
    },
    {
      id: "display",
      component: "Card",
      children: ["display-text"],
      className: "bg-muted",
    },
    {
      id: "display-text",
      component: "Text",
      text: { path: "/display" },
      variant: "heading2",
      align: "right",
      className: "font-mono p-2",
    },
    {
      id: "buttons",
      component: "Column",
      children: ["row1", "row2", "row3", "row4", "row5"],
      className: "gap-1",
    },
    {
      id: "row1",
      component: "Row",
      children: ["btn-clear", "btn-backspace", "btn-percent", "btn-divide"],
      className: "gap-1",
    },
    {
      id: "row2",
      component: "Row",
      children: ["btn-7", "btn-8", "btn-9", "btn-multiply"],
      className: "gap-1",
    },
    {
      id: "row3",
      component: "Row",
      children: ["btn-4", "btn-5", "btn-6", "btn-subtract"],
      className: "gap-1",
    },
    {
      id: "row4",
      component: "Row",
      children: ["btn-1", "btn-2", "btn-3", "btn-add"],
      className: "gap-1",
    },
    {
      id: "row5",
      component: "Row",
      children: ["btn-0", "btn-decimal", "btn-equals"],
      className: "gap-1",
    },
    // Number buttons
    {
      id: "btn-0",
      component: "Button",
      text: "0",
      action: "input_0",
      variant: "outline",
      className: "flex-[2]",
    },
    { id: "btn-1", component: "Button", text: "1", action: "input_1", variant: "outline" },
    { id: "btn-2", component: "Button", text: "2", action: "input_2", variant: "outline" },
    { id: "btn-3", component: "Button", text: "3", action: "input_3", variant: "outline" },
    { id: "btn-4", component: "Button", text: "4", action: "input_4", variant: "outline" },
    { id: "btn-5", component: "Button", text: "5", action: "input_5", variant: "outline" },
    { id: "btn-6", component: "Button", text: "6", action: "input_6", variant: "outline" },
    { id: "btn-7", component: "Button", text: "7", action: "input_7", variant: "outline" },
    { id: "btn-8", component: "Button", text: "8", action: "input_8", variant: "outline" },
    { id: "btn-9", component: "Button", text: "9", action: "input_9", variant: "outline" },
    {
      id: "btn-decimal",
      component: "Button",
      text: ".",
      action: "input_decimal",
      variant: "outline",
    },
    // Operator buttons
    { id: "btn-add", component: "Button", text: "+", action: "op_add", variant: "secondary" },
    {
      id: "btn-subtract",
      component: "Button",
      text: "-",
      action: "op_subtract",
      variant: "secondary",
    },
    {
      id: "btn-multiply",
      component: "Button",
      text: "×",
      action: "op_multiply",
      variant: "secondary",
    },
    { id: "btn-divide", component: "Button", text: "÷", action: "op_divide", variant: "secondary" },
    {
      id: "btn-percent",
      component: "Button",
      text: "%",
      action: "op_percent",
      variant: "secondary",
    },
    { id: "btn-equals", component: "Button", text: "=", action: "calculate", variant: "primary" },
    { id: "btn-clear", component: "Button", text: "C", action: "clear", variant: "destructive" },
    {
      id: "btn-backspace",
      component: "Button",
      text: "⌫",
      action: "backspace",
      variant: "outline",
    },
  ] as A2UIComponent[],
  dataModel: {
    display: "0",
    currentValue: 0,
    previousValue: null,
    operator: null,
    waitingForOperand: false,
  },
}

/**
 * Timer/Stopwatch Template
 */
export const timerTemplate: A2UIAppTemplate = {
  id: "timer",
  name: "Timer",
  description: "A countdown timer and stopwatch app",
  icon: "Timer",
  category: "utility",
  tags: ["timer", "stopwatch", "countdown", "time"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "display-card", "controls", "presets"],
      className: "gap-4 p-4 max-w-sm items-center",
    },
    { id: "header", component: "Text", text: "⏱️ Timer", variant: "heading2" },
    {
      id: "display-card",
      component: "Card",
      children: ["time-display", "progress-bar"],
      className: "w-full text-center p-6",
    },
    {
      id: "time-display",
      component: "Text",
      text: { path: "/display" },
      variant: "heading1",
      className: "font-mono text-4xl",
    },
    {
      id: "progress-bar",
      component: "Progress",
      value: { path: "/progress" },
      max: 100,
      className: "mt-4",
    },
    {
      id: "controls",
      component: "Row",
      children: ["start-btn", "pause-btn", "reset-btn"],
      className: "gap-2",
    },
    {
      id: "start-btn",
      component: "Button",
      text: "Start",
      action: "start_timer",
      variant: "primary",
      icon: "Play",
    },
    {
      id: "pause-btn",
      component: "Button",
      text: "Pause",
      action: "pause_timer",
      variant: "secondary",
      icon: "Pause",
    },
    {
      id: "reset-btn",
      component: "Button",
      text: "Reset",
      action: "reset_timer",
      variant: "outline",
      icon: "RotateCcw",
    },
    {
      id: "presets",
      component: "Row",
      children: ["preset-1", "preset-5", "preset-10", "preset-25"],
      className: "gap-2 flex-wrap justify-center",
    },
    { id: "preset-1", component: "Button", text: "1 min", action: "set_1min", variant: "ghost" },
    { id: "preset-5", component: "Button", text: "5 min", action: "set_5min", variant: "ghost" },
    { id: "preset-10", component: "Button", text: "10 min", action: "set_10min", variant: "ghost" },
    { id: "preset-25", component: "Button", text: "25 min", action: "set_25min", variant: "ghost" },
  ] as A2UIComponent[],
  dataModel: {
    display: "00:00",
    seconds: 0,
    totalSeconds: 0,
    progress: 0,
    isRunning: false,
  },
}

/**
 * Weather Widget Template
 */
export const weatherTemplate: A2UIAppTemplate = {
  id: "weather",
  name: "Weather Widget",
  description: "Display current weather information",
  icon: "Cloud",
  category: "utility",
  tags: ["weather", "widget", "utility"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["main-card", "details-row"],
      className: "gap-4 p-4 max-w-sm",
    },
    {
      id: "main-card",
      component: "Card",
      children: ["location-row", "temp-row", "condition"],
      className: "bg-gradient-to-br from-blue-500 to-blue-600 text-white p-6",
    },
    {
      id: "location-row",
      component: "Row",
      children: ["location-icon", "location-text"],
      className: "gap-2 items-center",
    },
    { id: "location-icon", component: "Icon", name: "MapPin", size: 16 },
    {
      id: "location-text",
      component: "Text",
      text: { path: "/weather/location" },
      variant: "body",
    },
    {
      id: "temp-row",
      component: "Row",
      children: ["weather-icon", "temperature"],
      className: "gap-4 items-center my-4",
    },
    { id: "weather-icon", component: "Icon", name: { path: "/weather/icon" }, size: 64 },
    {
      id: "temperature",
      component: "Text",
      text: { path: "/weather/temperature" },
      variant: "heading1",
      className: "text-5xl",
    },
    { id: "condition", component: "Text", text: { path: "/weather/condition" }, variant: "body" },
    {
      id: "details-row",
      component: "Row",
      children: ["humidity-card", "wind-card", "uv-card"],
      className: "gap-2",
    },
    {
      id: "humidity-card",
      component: "Card",
      children: ["humidity-label", "humidity-value"],
      className: "flex-1 p-3 text-center",
    },
    { id: "humidity-label", component: "Text", text: "💧 Humidity", variant: "caption" },
    {
      id: "humidity-value",
      component: "Text",
      text: { path: "/weather/humidity" },
      variant: "heading4",
    },
    {
      id: "wind-card",
      component: "Card",
      children: ["wind-label", "wind-value"],
      className: "flex-1 p-3 text-center",
    },
    { id: "wind-label", component: "Text", text: "💨 Wind", variant: "caption" },
    { id: "wind-value", component: "Text", text: { path: "/weather/wind" }, variant: "heading4" },
    {
      id: "uv-card",
      component: "Card",
      children: ["uv-label", "uv-value"],
      className: "flex-1 p-3 text-center",
    },
    { id: "uv-label", component: "Text", text: "☀️ UV", variant: "caption" },
    { id: "uv-value", component: "Text", text: { path: "/weather/uv" }, variant: "heading4" },
  ] as A2UIComponent[],
  dataModel: {
    weather: {
      location: "San Francisco, CA",
      temperature: "72°F",
      condition: "Partly Cloudy",
      icon: "CloudSun",
      humidity: "65%",
      wind: "12 mph",
      uv: "Moderate",
    },
  },
}

/**
 * Unit Converter Template
 */
export const unitConverterTemplate: A2UIAppTemplate = {
  id: "unit-converter",
  name: "Unit Converter",
  description: "Convert between different units of measurement",
  icon: "ArrowLeftRight",
  category: "utility",
  tags: ["converter", "units", "utility", "measurement"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "converter-card", "result-card"],
      className: "gap-4 p-4 max-w-md",
    },
    { id: "header", component: "Text", text: "🔄 Unit Converter", variant: "heading2" },
    {
      id: "converter-card",
      component: "Card",
      children: ["type-select", "input-row", "unit-row", "convert-btn"],
      className: "p-4",
    },
    {
      id: "type-select",
      component: "Select",
      value: { path: "/converterType" },
      label: "Type",
      options: [
        { value: "length", label: "Length" },
        { value: "weight", label: "Weight" },
        { value: "temperature", label: "Temperature" },
      ],
    },
    {
      id: "input-row",
      component: "TextField",
      value: { path: "/inputValue" },
      label: "Value",
      type: "number",
      placeholder: "0",
    },
    {
      id: "unit-row",
      component: "Row",
      children: ["from-unit", "arrow", "to-unit"],
      className: "gap-2 items-center",
    },
    {
      id: "from-unit",
      component: "Select",
      value: { path: "/fromUnit" },
      label: "From",
      options: [
        { value: "m", label: "Meter" },
        { value: "cm", label: "Centimeter" },
        { value: "ft", label: "Feet" },
      ],
      className: "flex-1",
    },
    { id: "arrow", component: "Icon", name: "ArrowRight", size: 20 },
    {
      id: "to-unit",
      component: "Select",
      value: { path: "/toUnit" },
      label: "To",
      options: [
        { value: "m", label: "Meter" },
        { value: "cm", label: "Centimeter" },
        { value: "ft", label: "Feet" },
      ],
      className: "flex-1",
    },
    {
      id: "convert-btn",
      component: "Button",
      text: "Convert",
      action: "convert",
      variant: "primary",
      className: "mt-4 w-full",
    },
    {
      id: "result-card",
      component: "Card",
      children: ["result-label", "result-value"],
      className: "text-center p-6 bg-muted",
    },
    { id: "result-label", component: "Text", text: "Result", variant: "caption" },
    {
      id: "result-value",
      component: "Text",
      text: { path: "/result" },
      variant: "heading1",
      className: "font-mono",
    },
  ] as A2UIComponent[],
  dataModel: {
    converterType: "length",
    inputValue: "",
    fromUnit: "m",
    toUnit: "cm",
    result: "0",
  },
}
