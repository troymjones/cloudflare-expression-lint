# cloudflare-expression-lint

## What This Is
A TypeScript parser, validator, and linter for Cloudflare Rules Language expressions. It catches errors in Cloudflare expressions before they reach `terraform apply`. Published on npm as `cloudflare-expression-lint`.

## Project Structure
- `src/lexer.ts` — Tokenizer (string → Token[]), supports raw strings (r"...")
- `src/parser.ts` — Recursive-descent parser (Token[] → AST) with correct operator precedence
- `src/validator.ts` — Semantic validator (AST → Diagnostic[]) with:
  - Operator type checking (e.g., `contains` only on String)
  - Deprecated field detection with replacement suggestions
  - Phase-specific field availability
  - Function context and usage limit validation
  - Account-level zone plan filter checking
  - Expression Builder compatibility checking
  - Ambiguous operator precedence detection
  - Operator style checking (C-like vs English notation)
  - Expression whitespace detection
  - Boolean comparison style hints
  - Regex count limits, CIDR validation, wildcard pattern checks
  - Named list name validation, header key casing warnings
  - Template placeholder detection
- `src/yaml-scanner.ts` — YAML file scanner with configurable expression key and phase mappings, account-level path detection
- `src/eslint-plugin.ts` — ESLint plugin adapter (optional, uses yaml-eslint-parser)
- `src/cli.ts` — CLI entry point with --config, --expr-key, --phase-map, --warn-exit-code, --ignore-code flags
- `src/types.ts` — All type definitions
- `src/schemas/fields.ts` — Field registry (211+ fields with types, deprecation, phase availability, load balancing and DNS fields)
- `src/schemas/functions.ts` — Function registry (25+ functions with context restrictions, including hash_in_range)
- `src/schemas/operators.ts` — Operator definitions with type constraints
- `src/__tests__/` — Test suite (418 tests across 13 files)
- `scripts/sync-cloudflare-docs.ts` — Automated sync from cloudflare-docs repo (fields + functions)

## Commands
- `npm test` — Run tests (vitest)
- `npm run build` — Build TypeScript to dist/
- `node dist/cli.js -e 'EXPRESSION'` — Validate a single expression
- `node dist/cli.js config/**/*.yaml` — Scan YAML files
- `node dist/cli.js --config .cf-expr-lint.json config/**/*.yaml` — Scan with custom mappings
- `npm run sync-docs` — Check for Cloudflare field/function updates (dry run)
- `npm run sync-docs:apply` — Apply field/function updates from Cloudflare docs

## Publishing
```bash
npm version patch    # bumps version, creates commit + tag
git push && git push --tags   # triggers auto-publish via OIDC Trusted Publishing
```

## How to Add a New Field
Add an entry to the `FIELDS` array in `src/schemas/fields.ts`:
```typescript
{ name: 'cf.new_field', type: 'String' },
// With deprecation:
{ name: 'old.field', type: 'String', deprecated: true, replacement: 'new.field' },
// With phase restriction:
{ name: 'http.response.new', type: 'String', phases: ['http_response_headers_transform'] },
```

## How to Add a New Function
Add an entry to the `FUNCTIONS` array in `src/schemas/functions.ts`:
```typescript
{
  name: 'new_function',
  params: [{ name: 'input', type: 'String' }],
  returnType: 'String',
  contexts: ['all'],  // or ['filter'], ['rewrite_url', 'rewrite_header'], etc.
  maxPerExpression: 1, // optional usage limit
},
```

## How to Customize YAML Scanning
The scanner only detects the `expression` key by default. Custom expression keys and phase mappings can be added via:
- CLI: `--expr-key key:type[:phase]` and `--phase-map yaml_key:phase`
- Config file: `.cf-expr-lint.json` with `expressionKeys`, `phaseMappings`, `ignoreCodes`, `accountLevelPaths`
- Programmatic API: `scanYaml(content, file, { expressionKeys: {...}, phaseMappings: {...} })`

Custom mappings always merge with built-in defaults.

## Config File Options
```json
{
  "expressionKeys": { "my_key": { "type": "filter", "phaseHint": "http_request_firewall_custom" } },
  "phaseMappings": { "my_waf_rules": "http_request_firewall_custom" },
  "ignoreCodes": ["contains-placeholders", "parse-error-placeholder"],
  "accountLevelPaths": ["config/account/"],
  "operatorStyle": "off"
}
```

## Expression Types
- `filter` — Boolean expressions (the "when" condition in rules)
- `rewrite_url` — URL rewrite value expressions (e.g., regex_replace result)
- `rewrite_header` — Header value expressions
- `redirect_target` — Redirect target URL expressions

## Cloudflare Expression Builder Format
The Builder requires:
- Single group: `(cond [and cond ...])` — conditions joined by `and` inside one `()`
- Or-chain: `(group) or (group) or ...` — groups joined by `or` at top level
- `not` is a toggle on individual conditions INSIDE groups: `(not A and not B)`
- Each condition: comparison, in-expression, or boolean field

NOT Builder-compatible (with suggested rewrites):
- `(A) and (B)` → merge: `(A and B)`
- `(A or B)` → split: `(A) or (B)`
- `not (A)` → move not inside: `(not A)`
- `not (A or B)` → De Morgan's: `(not A and not B)`
- `((A) or (B))` → remove outer parens: `(A) or (B)`
- `((A or B) and C)` → distribute: `(A and C) or (B and C)`
- Functions/array unpacks are silently skipped (no Builder fix possible)

## CI Integration
The CLI supports exit codes for CI pipelines:
- `--warn-exit-code 2` — exit 2 on warnings (use with GitLab `allow_failure: exit_codes: [2]`)
- `--quiet` — only show errors
- `--ignore-code <code>` — suppress specific diagnostic codes
- `--operator-style <english|clike|off>` — operator style preference (default: english)

## Key Design Decisions
- Schemas are data, not code — field/function definitions are in simple arrays
- Parser is custom (not using wirefilter WASM) for better error messages
- ESLint is an optional peer dependency — the core tool is standalone
- The validator produces errors for invalid expressions, warnings for likely issues, info for style suggestions
- YAML scanner phase mappings are configurable — built-in defaults only include Cloudflare phase names and common shorthands
- Account-level expressions are detected by file path pattern, not YAML key name
- Template placeholder expressions (UPPER_CASE_VARS) are demoted from errors to warnings
- Published via OIDC Trusted Publishing — no npm tokens needed
- Weekly automated sync from cloudflare-docs repo for field/function updates
