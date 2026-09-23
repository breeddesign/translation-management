import Handlebars from "handlebars";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = join(__dirname, "..", "views");
const cache = new Map<string, HandlebarsTemplateDelegate>();

// ── Load & compile template ─────────────────────────────────

function getTemplate(name: string): HandlebarsTemplateDelegate {
  if (cache.has(name)) return cache.get(name)!;
  const source = readFileSync(join(VIEWS_DIR, `${name}.hbs`), "utf-8");
  const compiled = Handlebars.compile(source);
  cache.set(name, compiled);
  return compiled;
}

// ── Render with layout ──────────────────────────────────────

export function render(
  template: string,
  data: Record<string, unknown> = {}
): string {
  const layout = getTemplate("layout");
  const content = getTemplate(template);
  return layout({ ...data, body: content(data) });
}

// ── Render partial (for HTMX fragments) ─────────────────────

export function renderPartial(
  template: string,
  data: Record<string, unknown> = {}
): string {
  const tmpl = getTemplate(template);
  return tmpl(data);
}

// ── Register Partials ───────────────────────────────────────

const partialFiles = [
  ["folderTreeItem", "folder-tree-item.hbs"],
  ["folder-content", "folder-content.hbs"],
  ["status-cards", "status-cards.hbs"],
  ["proofreads-table", "proofreads-table.hbs"],
  ["translated-table", "translated-table.hbs"],
  ["heygen-videos-table", "heygen-videos-table.hbs"],
] as const;

for (const [name, file] of partialFiles) {
  Handlebars.registerPartial(
    name,
    readFileSync(join(VIEWS_DIR, "partials", file), "utf-8")
  );
}

// ── Register Helpers ────────────────────────────────────────

Handlebars.registerHelper("statusBadge", (status: string) => {
  const colors: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    processing: "bg-blue-100 text-blue-700",
    completed: "bg-green-100 text-green-700",
    edited: "bg-yellow-100 text-yellow-700",
    generating: "bg-purple-100 text-purple-700",
    done: "bg-emerald-100 text-emerald-700",
    failed: "bg-red-100 text-red-700",
    uploaded: "bg-sky-100 text-sky-700",
    draft: "bg-gray-100 text-gray-600",
    active: "bg-blue-100 text-blue-700",
    archived: "bg-gray-200 text-gray-500",
  };
  const cls = colors[status] ?? "bg-gray-100 text-gray-700";
  return new Handlebars.SafeString(
    `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}">${status}</span>`
  );
});

Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
/** 0-basierter @index → 1-basierte Zeilennummer */
Handlebars.registerHelper("inc", (value: unknown) => Number(value) + 1);
Handlebars.registerHelper("json", (obj: unknown) =>
  new Handlebars.SafeString(JSON.stringify(obj, null, 2))
);
Handlebars.registerHelper("formatDate", (date: Date | string) => {
  return new Date(date).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
});
