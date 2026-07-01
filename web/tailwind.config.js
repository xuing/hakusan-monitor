import animate from "tailwindcss-animate";
import headlessui from "@headlessui/tailwindcss";

/**
 * Tailwind v3 config unifying two systems on one Radix-Colors dark palette:
 *  - shadcn/ui  -> `hsl(var(--token))` tokens (see src/index.css)
 *  - Tremor     -> `dark-tremor-*` tokens (charts/KPI blocks)
 * Status colors (ok/warn/bad/info) come straight from Radix scales.
 */
export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["ui-monospace", "JetBrains Mono", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        // semantic status scales, straight from Radix Colors (src/index.css)
        ok: { DEFAULT: "var(--green-10)", soft: "var(--green-a4)", fg: "var(--green-11)" },
        warn: { DEFAULT: "var(--amber-10)", soft: "var(--amber-a4)", fg: "var(--amber-11)" },
        bad: { DEFAULT: "var(--red-10)", soft: "var(--red-a4)", fg: "var(--red-11)" },
        info: { DEFAULT: "var(--blue-10)", soft: "var(--blue-a4)", fg: "var(--blue-11)" },
        // Tremor — light tokens
        tremor: {
          brand: {
            faint: "#eff6ff", muted: "#bfdbfe", subtle: "#60a5fa",
            DEFAULT: "#0090ff", emphasis: "#1d4ed8", inverted: "#ffffff",
          },
          background: { muted: "#f9fafb", subtle: "#f3f4f6", DEFAULT: "#ffffff", emphasis: "#374151" },
          border: { DEFAULT: "#e5e7eb" },
          ring: { DEFAULT: "#e5e7eb" },
          content: {
            subtle: "#9ca3af", DEFAULT: "#6b7280", emphasis: "#374151",
            strong: "#111827", inverted: "#ffffff",
          },
        },
        // Tremor — dark tokens
        "dark-tremor": {
          brand: {
            faint: "#0B1220", muted: "#18293f", subtle: "#1f5fa6",
            DEFAULT: "#0090ff", emphasis: "#3b9eff", inverted: "#0a0a0a",
          },
          background: { muted: "#111113", subtle: "#18191b", DEFAULT: "#15171a", emphasis: "#b0b4ba" },
          border: { DEFAULT: "#2a2d31" },
          ring: { DEFAULT: "#2a2d31" },
          content: {
            subtle: "#696e77", DEFAULT: "#878d96", emphasis: "#d6dade",
            strong: "#edeef0", inverted: "#0a0a0a",
          },
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        "tremor-small": "0.375rem", "tremor-default": "0.5rem", "tremor-full": "9999px",
      },
      boxShadow: {
        "tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        "dark-tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "dark-tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.5), 0 1px 2px -1px rgb(0 0 0 / 0.5)",
        "dark-tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.5), 0 2px 4px -2px rgb(0 0 0 / 0.5)",
      },
      fontSize: {
        "tremor-label": ["0.75rem", { lineHeight: "1rem" }],
        "tremor-default": ["0.875rem", { lineHeight: "1.25rem" }],
        "tremor-title": ["1.125rem", { lineHeight: "1.75rem" }],
        "tremor-metric": ["1.875rem", { lineHeight: "2.25rem" }],
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
        "fade-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
        "pulse-dot": { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.4" } },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.25s ease",
        "pulse-dot": "pulse-dot 2s ease-in-out infinite",
      },
    },
  },
  safelist: [
    {
      pattern:
        /^(bg|text|border|ring|fill|stroke)-(blue|emerald|amber|rose|violet|cyan|slate|gray)-(50|100|200|300|400|500|600|700|800|900|950)$/,
      variants: ["hover", "ui-selected"],
    },
  ],
  plugins: [animate, headlessui],
};
