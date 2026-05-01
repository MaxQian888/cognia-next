/**
 * A2UI Form Templates
 * Templates for input forms and surveys
 */

import type { A2UIComponent } from "@/types/a2ui/schema"
import type { A2UIAppTemplate } from "./types"

/**
 * Survey/Feedback Form Template
 */
export const surveyFormTemplate: A2UIAppTemplate = {
  id: "survey-form",
  name: "Survey Form",
  description: "A customizable survey or feedback collection form",
  icon: "ClipboardList",
  category: "form",
  tags: ["survey", "feedback", "form", "questionnaire"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "form-card", "submit-row"],
      className: "gap-4 p-4 max-w-md",
    },
    { id: "header", component: "Column", children: ["title", "description"], className: "gap-1" },
    { id: "title", component: "Text", text: "📋 Quick Survey", variant: "heading2" },
    {
      id: "description",
      component: "Text",
      text: "Help us improve by answering a few questions",
      variant: "caption",
      color: "muted",
    },
    {
      id: "form-card",
      component: "Card",
      children: ["name-field", "email-field", "rating-section", "feedback-field"],
      className: "p-4",
    },
    {
      id: "name-field",
      component: "TextField",
      value: { path: "/form/name" },
      label: "Your Name",
      placeholder: "Enter your name",
      required: true,
    },
    {
      id: "email-field",
      component: "TextField",
      value: { path: "/form/email" },
      label: "Email Address",
      placeholder: "your@email.com",
      type: "email",
    },
    {
      id: "rating-section",
      component: "Column",
      children: ["rating-label", "rating-slider", "rating-value"],
      className: "gap-2 my-4",
    },
    {
      id: "rating-label",
      component: "Text",
      text: "How would you rate your experience?",
      variant: "label",
    },
    {
      id: "rating-slider",
      component: "Slider",
      value: { path: "/form/rating" },
      min: 1,
      max: 10,
      step: 1,
      showValue: true,
    },
    {
      id: "rating-value",
      component: "Text",
      text: { path: "/form/ratingText" },
      variant: "caption",
      align: "center",
    },
    {
      id: "feedback-field",
      component: "TextArea",
      value: { path: "/form/feedback" },
      label: "Additional Feedback",
      placeholder: "Tell us more about your experience...",
      rows: 4,
    },
    {
      id: "submit-row",
      component: "Row",
      children: ["clear-btn", "submit-btn"],
      className: "gap-2 justify-end",
    },
    {
      id: "clear-btn",
      component: "Button",
      text: "Clear",
      action: "clear_form",
      variant: "outline",
    },
    {
      id: "submit-btn",
      component: "Button",
      text: "Submit",
      action: "submit_form",
      variant: "primary",
      icon: "Send",
    },
  ] as A2UIComponent[],
  dataModel: {
    form: {
      name: "",
      email: "",
      rating: 5,
      ratingText: "5/10 - Average",
      feedback: "",
    },
    submitted: false,
  },
}

/**
 * Contact Form Template
 */
export const contactFormTemplate: A2UIAppTemplate = {
  id: "contact-form",
  name: "Contact Form",
  description: "A professional contact form with validation",
  icon: "Mail",
  category: "form",
  tags: ["contact", "form", "email", "support"],
  components: [
    {
      id: "root",
      component: "Column",
      children: ["header", "form-content", "submit-section"],
      className: "gap-4 p-4 max-w-md",
    },
    {
      id: "header",
      component: "Column",
      children: ["title", "subtitle"],
      className: "text-center gap-1",
    },
    { id: "title", component: "Text", text: "✉️ Contact Us", variant: "heading2" },
    {
      id: "subtitle",
      component: "Text",
      text: "We'd love to hear from you!",
      variant: "caption",
      color: "muted",
    },
    {
      id: "form-content",
      component: "Card",
      children: ["name-row", "email-input", "subject-select", "message-input"],
      className: "p-4",
    },
    { id: "name-row", component: "Row", children: ["first-name", "last-name"], className: "gap-2" },
    {
      id: "first-name",
      component: "TextField",
      value: { path: "/form/firstName" },
      label: "First Name",
      placeholder: "John",
      required: true,
      className: "flex-1",
    },
    {
      id: "last-name",
      component: "TextField",
      value: { path: "/form/lastName" },
      label: "Last Name",
      placeholder: "Doe",
      required: true,
      className: "flex-1",
    },
    {
      id: "email-input",
      component: "TextField",
      value: { path: "/form/email" },
      label: "Email Address",
      placeholder: "john@example.com",
      type: "email",
      required: true,
    },
    {
      id: "subject-select",
      component: "Select",
      value: { path: "/form/subject" },
      label: "Subject",
      placeholder: "Select a topic...",
      options: [
        { value: "general", label: "General Inquiry" },
        { value: "support", label: "Technical Support" },
        { value: "sales", label: "Sales Question" },
        { value: "feedback", label: "Feedback" },
        { value: "other", label: "Other" },
      ],
      required: true,
    },
    {
      id: "message-input",
      component: "TextArea",
      value: { path: "/form/message" },
      label: "Message",
      placeholder: "Tell us how we can help...",
      rows: 5,
      required: true,
    },
    {
      id: "submit-section",
      component: "Row",
      children: ["privacy-notice", "spacer", "submit-btn"],
      className: "items-center",
    },
    {
      id: "privacy-notice",
      component: "Text",
      text: "We respect your privacy.",
      variant: "caption",
      color: "muted",
    },
    { id: "spacer", component: "Spacer", size: 16, className: "flex-1" },
    {
      id: "submit-btn",
      component: "Button",
      text: "Send Message",
      action: "submit_contact",
      variant: "primary",
      icon: "Send",
    },
  ] as A2UIComponent[],
  dataModel: {
    form: {
      firstName: "",
      lastName: "",
      email: "",
      subject: "",
      message: "",
    },
    submitted: false,
  },
}
