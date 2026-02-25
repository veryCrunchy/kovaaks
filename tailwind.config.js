/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        overlay: {
          bg: "rgba(10, 10, 15, 0.85)",
          border: "rgba(255, 255, 255, 0.08)",
          accent: "#00f5a0",
          danger: "#ff4d4d",
          warn: "#ffd700",
        },
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "monospace"],
      },
    },
  },
  plugins: [],
};
