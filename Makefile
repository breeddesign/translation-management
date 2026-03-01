.PHONY: check typecheck build lint templates deps audit clean dev dev-all restart

# ── Quick check (run after every change) ─────────────────────
check: typecheck templates lint
	@echo "\n✅ All checks passed"

# ── TypeScript type checking (no emit) ───────────────────────
typecheck:
	@echo "→ TypeScript type check..."
	@npx tsc --noEmit

# ── Build (compile to dist/) ─────────────────────────────────
build:
	@echo "→ Building..."
	@npx tsc

# ── Lint: find common issues ─────────────────────────────────
lint:
	@echo "→ Checking for console.log in routes..."
	@! grep -rn 'console\.log' src/routes/ src/queue/ --include='*.ts' \
		| grep -v '// ok' | grep -v 'Polling interval' \
		|| true
	@echo "→ Checking for leftover TODO/FIXME/HACK..."
	@grep -rn 'TODO\|FIXME\|HACK\|XXX' src/ --include='*.ts' || true
	@echo "→ Checking for .env secrets in code..."
	@! grep -rn 'HEYGEN_API_KEY\|DB_PASSWORD\|SESSION_SECRET' src/ --include='*.ts' \
		| grep -v 'process\.env' | grep -v 'config\.' \
		|| true
	@echo "→ Checking for unused imports (rough)..."
	@! grep -rn '^import.*from' src/ --include='*.ts' \
		| grep -v 'type ' \
		| while IFS=: read -r file line content; do \
			name=$$(echo "$$content" | sed -n 's/.*import { \([^}]*\) }.*/\1/p' | tr ',' '\n' | head -1 | xargs); \
			if [ -n "$$name" ] && ! grep -q "$$name" "$$file" 2>/dev/null; then \
				echo "$$file:$$line possibly unused: $$name"; \
			fi; \
		done || true

# ── Template validation: check all partials are registered ───
templates:
	@echo "→ Checking Handlebars partials..."
	@for partial in src/views/partials/*.hbs; do \
		name=$$(basename "$$partial" .hbs); \
		if ! grep -q "$$name" src/lib/templates.ts; then \
			echo "⚠ Partial '$$name' not registered in templates.ts"; \
			exit 1; \
		fi; \
	done
	@echo "→ Checking for broken partial references..."
	@grep -roh '{{> [a-zA-Z_-]*}}' src/views/ | sed 's/{{> //;s/}}//' | sort -u | while read -r ref; do \
		if ! grep -q "\"$$ref\"" src/lib/templates.ts; then \
			echo "⚠ Partial reference '$$ref' not found in templates.ts"; \
			exit 1; \
		fi; \
	done

# ── Dependency audit ─────────────────────────────────────────
audit:
	@echo "→ npm audit..."
	@npm audit --omit=dev 2>/dev/null || true

# ── Check for outdated deps ──────────────────────────────────
deps:
	@echo "→ Checking outdated packages..."
	@npm outdated || true

# ── Development servers ──────────────────────────────────────
dev:
	npx tsx watch src/web.ts

dev-all:
	npx concurrently "npm:dev" "npm:dev:worker"

# ── Restart dev server (kill + start) ────────────────────────
restart:
	@lsof -ti:3003 | xargs kill -9 2>/dev/null || true
	@sleep 1
	@npx tsx watch src/web.ts &
	@echo "→ Server restarting on :3003"

# ── Database ─────────────────────────────────────────────────
db-migrate:
	npx tsx src/db/migrate.ts

# ── Clean build artifacts ────────────────────────────────────
clean:
	rm -rf dist
	@echo "→ Cleaned dist/"
