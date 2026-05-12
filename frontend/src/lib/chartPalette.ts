/**
 * The single source of truth for chart colors. Recharts components
 * need raw hex values, so this is the one allowlisted place where
 * literal hex appears outside the Tailwind theme. If a chart needs a
 * new color, add it here — never inline.
 */
export const chartPalette = [
  "#1f2937", // ink (accent)
  "#1e3a8a", // info
  "#15803d", // success
  "#a16207", // warning
  "#b91c1c", // danger
  "#6b7280", // ink-subtle
] as const;

export const chartSeverityColor: Record<string, string> = {
  blocker: "#b91c1c",
  high: "#a16207",
  medium: "#1e3a8a",
  low: "#6b7280",
};
