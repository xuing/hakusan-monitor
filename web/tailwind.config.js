import animate from "tailwindcss-animate";

/**
 * Tailwind config on one Radix-Colors light/dark palette.
 * Status colors (ok/warn/bad/info) come straight from Radix scales.
 */
export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["ui-monospace", "JetBrains Mono", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        // Product UI floor: 13px at the 16px root. Large/HiDPI viewports lift
        // the root further, so captions remain crisp instead of falling back
        // to hand-tuned 10–12px text.
        xs: ["0.8125rem", { lineHeight: "1.125rem" }],
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
        ok: { DEFAULT: "var(--green-10)", soft: "var(--green-a2)", fg: "var(--status-ok-fg)" },
        warn: { DEFAULT: "var(--amber-10)", soft: "var(--amber-a2)", fg: "var(--status-warn-fg)" },
        bad: { DEFAULT: "var(--red-10)", soft: "var(--red-a2)", fg: "var(--status-bad-fg)" },
        info: { DEFAULT: "var(--blue-10)", soft: "var(--blue-a2)", fg: "var(--status-info-fg)" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
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
  plugins: [animate],
};
