import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        "finess-bg": "#0a0e1a",
        "finess-text": "#e2e8f0",
        "finess-muted": "#94a3b8",
        "finess-accent": "#3b82f6",
        "finess-amber": "#f59e0b",
        "finess-red": "#ef4444",
      },
    },
  },
  plugins: [],
};
export default config;
