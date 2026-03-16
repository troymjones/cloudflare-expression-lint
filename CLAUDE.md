# cloudflare-expression-lint

## What This Is
A TypeScript parser, validator, and linter for Cloudflare Rules Language expressions. It catches errors in Cloudflare expressions before they reach `terraform apply`.

## Project Structure
- `src/lexer.ts` — Tokenizer (string → Token[])
- `src/parser.ts` — Recursive-descent parser (Token[] → AST)
- `src/validator.ts` — Semantic validator (AST → Diagnostic[])
- `src/yaml-scanner.ts` — YAML file scanner with phase inference
- `src/cli.ts` — CLI entry point
- `src/types.ts` — All type definitions
- `src/schemas/fields.ts` — Field registry (211+ fields with types, deprecation, phase availability)
- `src/schemas/functions.ts` — Function registry (25+ functions with context restrictions)
- `src/schemas/operators.ts` — Operator definitions
- `src/__tests__/` — Test suite (203+ tests)

## Commands
- `npm test` — Run tests (vitest)
- `npm run build` — Build TypeScript to dist/
- `node dist/cli.js -e 'EXPRESSION'` — Validate a single expression
- `node dist/cli.js config/**/*.yaml` — Scan YAML files

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

## Expression Types
- `filter` — Boolean expressions (the "when" condition in rules)
- `rewrite_url` — URL rewrite value expressions (e.g., regex_replace result)
- `rewrite_header` — Header value expressions
- `redirect_target` — Redirect target URL expressions

## Key Design Decisions
- Schemas are data, not code — field/function definitions are in simple arrays
- Parser is custom (not using wirefilter WASM) for better error messages
- ESLint is NOT a dependency — this is a standalone tool
- The validator produces warnings for deprecated fields, errors for unknown/invalid ones
- YAML scanner infers Cloudflare phase from parent YAML keys (e.g., `waf_rules` → `http_request_firewall_custom`)
