/** @type {import('tailwindcss').Config} */
export default {
  // Klassen stehen in den Templates und in den Stellen, die HTML in TS bauen
  // (z. B. der statusBadge-Helper in src/lib/templates.ts).
  content: ["./src/views/**/*.hbs", "./src/**/*.ts"],
  theme: { extend: {} },
  plugins: [],
};
