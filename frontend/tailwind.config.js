/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#111827",
          muted: "#4b5563",
          subtle: "#6b7280",
        },
        rule: {
          DEFAULT: "#e5e7eb",
          strong: "#d1d5db",
        },
        canvas: {
          DEFAULT: "#ffffff",
          subtle: "#f9fafb",
          muted: "#f3f4f6",
        },
        accent: {
          DEFAULT: "#1f2937",
          ring: "#374151",
        },
        success: {
          DEFAULT: "#15803d",
          soft: "#ecfdf5",
          ring: "#a7f3d0",
        },
        warning: {
          DEFAULT: "#a16207",
          soft: "#fefce8",
          ring: "#fde68a",
        },
        danger: {
          DEFAULT: "#b91c1c",
          soft: "#fef2f2",
          ring: "#fecaca",
        },
        info: {
          DEFAULT: "#1e3a8a",
          soft: "#eff6ff",
          ring: "#bfdbfe",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        serif: ["Iowan Old Style", "Palatino Linotype", "Georgia", "serif"],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
