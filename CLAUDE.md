# cloudflare-expression-lint

## What This Is
A TypeScript parser, validator, and linter for Cloudflare Rules Language expressions. It catches errors in Cloudflare expressions before they reach `terraform apply`. Published on npm as `cloudflare-expression-lint`.

## Project Structure
- `src/lexer.ts` — Tokenizer (string → Token[]), supports raw strings (r"...")
- `src/parser.ts` — Recursive-descent parser (Token[] → AST)
- `src/validator.ts` — Semantic validator (AST → Diagnostic[]) with operator type checking, deprecation warnings, boolean style hints, regex count limits, CIDR validation, wildcard pattern checks, named list validation, header key casing warnings
- `src/yaml-scanner.ts` — YAML file scanner with configurable expression key and phase mappings
- `src/eslint-plugin.ts` — ESLint plugin adapter (optional, uses yaml-eslint-parser)
- `src/cli.ts` — CLI entry point with --config, --expr-key, --phase-map flags
- `src/types.ts` — All type definitions
- `src/schemas/fields.ts` — Field registry (211+ fields with types, deprecation, phase availability)
- `src/schemas/functions.ts` — Function registry (25+ functions with context restrictions)
- `src/schemas/operators.ts` — Operator definitions with type constraints
- `src/__tests__/` — Test suite (314 tests across 7 files)

## Commands
- `npm test` — Run tests (vitest)
- `npm run build` — Build TypeScript to dist/
- `node dist/cli.js -e 'EXPRESSION'` — Validate a single expression
- `node dist/cli.js config/**/*.yaml` — Scan YAML files
- `node dist/cli.js --config .cf-expr-lint.json config/**/*.yaml` — Scan with custom mappings

## Publishing
```bash
npm version patch    # bumps version, creates commit + tag
git push && git push --tags   # triggers auto-publish via OIDC
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
- Config file: `.cf-expr-lint.json` with `expressionKeys` and `phaseMappings`
- Programmatic API: `scanYaml(content, file, { expressionKeys: {...}, phaseMappings: {...} })`

Custom mappings always merge with built-in defaults.

## Expression Types
- `filter` — Boolean expressions (the "when" condition in rules)
- `rewrite_url` — URL rewrite value expressions (e.g., regex_replace result)
- `rewrite_header` — Header value expressions
- `redirect_target` — Redirect target URL expressions

## Key Design Decisions
- Schemas are data, not code — field/function definitions are in simple arrays
- Parser is custom (not using wirefilter WASM) for better error messages
- ESLint is an optional peer dependency — the core tool is standalone
- The validator produces warnings for deprecated fields, errors for unknown/invalid ones
- YAML scanner phase mappings are configurable — built-in defaults only include Cloudflare phase names and common shorthands
- Operator type checking catches mismatches at lint time (e.g., `contains` on IP fields)
- Published via OIDC Trusted Publishing — no npm tokens needed
