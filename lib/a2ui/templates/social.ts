/**
 * A2UI Social Templates
 * Templates for social and communication features
 */

import type { A2UIComponent } from "@/types/a2ui/schema"
import type { A2UIAppTemplate } from "./types"

/**
 * Profile Card Template
 */
export const profileCardTemplate: A2UIAppTemplate = {
  id: "profile-card",
  name: "Profile Card",
  description: "Display user profile information",
  icon: "User",
  category: "social",
  tags: ["profile", "user", "card", "social"],
  components: [
    { id: "root", component: "Column", children: ["card"], className: "gap-4 p-4 max-w-sm" },
    {
      id: "card",
      component: "Card",
      children: ["avatar-row", "info-section", "stats-row", "actions-row"],
      className: "p-6",
    },
    {
      id: "avatar-row",
      component: "Row",
      children: ["avatar", "name-col"],
      className: "gap-4 items-center",
    },
    {
      id: "avatar",
      component: "Image",
      src: { path: "/profile/avatar" },
      alt: "Avatar",
      className: "w-16 h-16 rounded-full",
    },
    { id: "name-col", component: "Column", children: ["name", "title"], className: "gap-1" },
    { id: "name", component: "Text", text: { path: "/profile/name" }, variant: "heading3" },
    {
      id: "title",
      component: "Text",
      text: { path: "/profile/title" },
      variant: "caption",
      color: "muted",
    },
    {
      id: "info-section",
      component: "Column",
      children: ["bio", "location-row"],
      className: "gap-2 mt-4",
    },
    { id: "bio", component: "Text", text: { path: "/profile/bio" }, variant: "body" },
    {
      id: "location-row",
      component: "Row",
      children: ["location-icon", "location-text"],
      className: "gap-1 items-center",
    },
    { id: "location-icon", component: "Icon", name: "MapPin", size: 14 },
    {
      id: "location-text",
      component: "Text",
      text: { path: "/profile/location" },
      variant: "caption",
    },
    {
      id: "stats-row",
      component: "Row",
      children: ["followers-stat", "following-stat", "posts-stat"],
      className: "gap-4 mt-4 justify-center",
    },
    {
      id: "followers-stat",
      component: "Column",
      children: ["followers-count", "followers-label"],
      className: "text-center",
    },
    {
      id: "followers-count",
      component: "Text",
      text: { path: "/stats/followers" },
      variant: "heading4",
    },
    { id: "followers-label", component: "Text", text: "Followers", variant: "caption" },
    {
      id: "following-stat",
      component: "Column",
      children: ["following-count", "following-label"],
      className: "text-center",
    },
    {
      id: "following-count",
      component: "Text",
      text: { path: "/stats/following" },
      variant: "heading4",
    },
    { id: "following-label", component: "Text", text: "Following", variant: "caption" },
    {
      id: "posts-stat",
      component: "Column",
      children: ["posts-count", "posts-label"],
      className: "text-center",
    },
    { id: "posts-count", component: "Text", text: { path: "/stats/posts" }, variant: "heading4" },
    { id: "posts-label", component: "Text", text: "Posts", variant: "caption" },
    {
      id: "actions-row",
      component: "Row",
      children: ["follow-btn", "message-btn"],
      className: "gap-2 mt-4",
    },
    {
      id: "follow-btn",
      component: "Button",
      text: "Follow",
      action: "follow",
      variant: "primary",
      className: "flex-1",
    },
    {
      id: "message-btn",
      component: "Button",
      text: "Message",
      action: "message",
      variant: "outline",
      className: "flex-1",
    },
  ] as A2UIComponent[],
  dataModel: {
    profile: {
      avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=default",
      name: "John Doe",
      title: "Software Developer",
      bio: "Building great products with code.",
      location: "San Francisco, CA",
    },
    stats: {
      followers: "1.2k",
      following: "345",
      posts: "42",
    },
  },
}
