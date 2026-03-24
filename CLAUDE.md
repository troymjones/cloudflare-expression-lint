# cloudflare-expression-lint

## What This Is
A TypeScript parser, validator, linter, formatter, and auto-fixer for Cloudflare Rules Language expressions. It catches errors in Cloudflare expressions before they reach `terraform apply`. Published on npm as `cloudflare-expression-lint`.

## Project Structure
- `src/lexer.ts` — Tokenizer (string → Token[]), supports raw strings (r"...")
- `src/parser.ts` — Recursive-descent parser (Token[] → AST), tracks raw string flag
- `src/validator.ts` — Semantic validator (AST → Diagnostic[]) with Builder compatibility checking, operator style, ambiguous precedence, deprecated fields, phase validation, function context/limits
- `src/fixer.ts` — Auto-fixer (AST → AST) for Builder compatibility: wraps bare expressions, merges and-groups, De Morgan's rewrites, operator style normalization
- `src/formatter.ts` — Prettifier (AST → multi-line string) that breaks on and/or boundaries, never mid-condition. Preserves raw strings.
- `src/rewriter.ts` — YAML file rewriter that replaces expressions in-place using >- block scalars. Supports converting | and |- to >-
- `src/yaml-scanner.ts` — YAML file scanner with configurable expression key and phase mappings, account-level path detection
- `src/eslint-plugin.ts` — ESLint plugin adapter (optional, uses yaml-eslint-parser)
- `src/cli.ts` — CLI with --fix, --prettify, --check, --convert-block-scalars, --config, --operator-style, --warn-exit-code flags
- `src/types.ts` — All type definitions (StringLiteralNode has `raw` flag)
- `src/schemas/fields.ts` — Field registry (211+ fields)
- `src/schemas/functions.ts` — Function registry (25+ functions)
- `src/schemas/operators.ts` — Operator definitions with type constraints
- `src/__tests__/` — Test suite (567 tests across 16 files)
- `scripts/sync-cloudflare-docs.ts` — Automated sync from cloudflare-docs repo

## Commands
- `npm test` — Run tests (vitest)
- `npm run build` — Build TypeScript to dist/
- `node dist/cli.js -e 'EXPRESSION'` — Validate a single expression
- `node dist/cli.js --fix -e 'EXPRESSION'` — Auto-fix a single expression
- `node dist/cli.js --prettify -e 'EXPRESSION'` — Format a single expression
- `node dist/cli.js --fix config/**/*.yaml` — Fix all YAML files
- `node dist/cli.js --fix --check config/**/*.yaml` — Dry-run fix check
- `node dist/cli.js --prettify --convert-block-scalars config/**/*.yaml` — Prettify and convert block scalars
- `node dist/cli.js --prettify --check config/**/*.yaml` — Dry-run prettify check
- `npm run sync-docs` — Check for Cloudflare field/function updates (dry run)
- `npm run sync-docs:apply` — Apply field/function updates from Cloudflare docs

## Publishing
```bash
npm version patch    # bumps version, creates commit + tag
git push && git push --tags   # triggers auto-publish via OIDC Trusted Publishing
```

## Cloudflare Expression Builder Format
The Builder requires:
- Single group: `(cond [and cond ...])` — conditions joined by `and` inside one `()`
- Or-chain: `(group) or (group) or ...` — groups joined by `or` at top level
- `not` is a toggle on individual conditions INSIDE groups: `(not A and not B)`
- Each condition: bare comparison, in-expression, boolean field, or function (starts_with, ends_with)
- Conditions inside and-groups must NOT be individually wrapped: `(A and B)` not `((A) and (B))`

NOT Builder-compatible (with `--fix` auto-rewrites):
- `(A) and (B)` → merge: `(A and B)`
- `(A or B)` → split: `(A) or (B)`
- `not (A)` → move not inside: `(not A)`
- `not (A or B)` → De Morgan's: `(not A and not B)`
- `not (A and B)` → De Morgan's: `(not A) or (not B)`
- `((A) or (B))` → remove outer parens: `(A) or (B)`
- `((A) and (B))` → unwrap: `(A and B)`

NOT auto-fixable (flagged as info only):
- `((A or B) and C)` — would require distribution, too risky to auto-apply
- Expressions with `lower()`, `len()` as comparison LHS — not representable in Builder

## Key Constraints
- NEVER add Indeed, Glassdoor, or any proprietary references to the GitHub repo (tests, docs, comments, git history)
- Raw strings (r"...") must be preserved through all transformations (fix, prettify, rewrite)
- The prettifier only breaks on and/or boundaries, never within a condition
- The >- (folded, strip) block scalar is the correct YAML choice for expressions
- `--check` mode must exit 1 if changes would be made, 0 if clean

## CI Integration
```yaml
# GitLab CI example
- cf-expr-lint --warn-exit-code 2 --config .cf-expr-lint.json $(find config -name "*.yaml")
- cf-expr-lint --fix --check --config .cf-expr-lint.json $(find config -name "*.yaml")
- cf-expr-lint --prettify --check --config .cf-expr-lint.json $(find config -name "*.yaml")
```
