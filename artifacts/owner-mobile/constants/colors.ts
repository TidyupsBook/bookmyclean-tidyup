/**
 * Semantic design tokens synced from the Book My Cleaning web app
 * (artifacts/book-my-cleaning/src/index.css). The product is dark-first:
 * near-black warm background with an orange → pink → purple brand gradient.
 */

const palette = {
  // Legacy aliases (kept for backward compatibility)
  text: "#f5f2f8",
  tint: "#ec4899",

  // Core surfaces
  background: "#0d0a0f",
  foreground: "#f5f2f8",

  // Cards / elevated surfaces
  card: "#171119",
  cardForeground: "#f5f2f8",

  // Primary action color (buttons, links, active states)
  primary: "#ec4899",
  primaryForeground: "#ffffff",

  // Secondary / less-emphasis interactive surfaces
  secondary: "#211a26",
  secondaryForeground: "#e9e2ef",

  // Muted / subdued elements (dividers, timestamps, placeholders)
  muted: "#1c151f",
  mutedForeground: "#9b8fa8",

  // Accent highlights
  accent: "#211a26",
  accentForeground: "#e9e2ef",

  // Destructive actions (delete, error states)
  destructive: "#ef4444",
  destructiveForeground: "#ffffff",

  // Borders and input outlines
  border: "#2a2130",
  input: "#2a2130",

  // Brand gradient stops
  brandOrange: "#ff7b54",
  brandPink: "#ec4899",
  brandPurple: "#a855f7",

  // Status
  success: "#34d399",
  warning: "#fbbf24",
};

const colors = {
  light: palette,
  dark: palette,
  radius: 13,
};

export default colors;
