# cloudflare-expression-lint

A parser, validator, linter, formatter, and auto-fixer for [Cloudflare Rules Language](https://developers.cloudflare.com/ruleset-engine/rules-language/) expressions with phase-aware field and function checking.

Catches errors **before** `terraform apply` — no API calls required.

## Features

- **Full expression parser** — lexer + recursive-descent parser for the Cloudflare wirefilter expression syntax
- **211+ known fields** with type information
- **Deprecated field detection** — warns on legacy fields like `ip.geoip.country` with replacement suggestions
- **Phase-aware validation** — knows which fields are available in which Cloudflare phase
- **Function context validation** — `regex_replace()` is only valid in rewrite/redirect contexts
- **Expression Builder compatibility** — flags expressions that can't be loaded in the Cloudflare UI
- **Auto-fixer** — `--fix` rewrites expressions for Builder compatibility (wraps bare expressions, merges and-groups, applies De Morgan's law, normalizes operators)
- **Prettifier** — `--prettify` reformats long expressions across multiple lines using `>-` block scalars
- **Operator style** — configurable preference for English (`eq`, `and`) vs C-like (`==`, `&&`)
- **YAML scanner** — auto-detects expressions in YAML files and infers Cloudflare phase from context
- **Raw string preservation** — `r"..."` prefixes survive formatting and fixing
- **CLI tool** — validate, fix, and format expressions from the command line or CI/CD pipelines
- **Programmatic API** — use as a library in your own tools

## Installation

```bash
npm install cloudflare-expression-lint
```

Or run directly with npx:

```bash
npx cloudflare-expression-lint config/**/*.yaml
```

## CLI Usage

### Validate YAML files

```bash
# Scan all YAML files for expressions
cf-expr-lint config/**/*.yaml

# Scan with JSON output (for CI integration)
cf-expr-lint --format json config/**/*.yaml

# Only show errors (suppress warnings)
cf-expr-lint --quiet config/**/*.yaml
```

### Validate a single expression

```bash
# Filter expression (default)
cf-expr-lint -e '(http.host eq "example.com")'

# Rewrite expression
cf-expr-lint -e 'regex_replace(http.request.uri.path, "^/old/", "/new/")' -t rewrite_url

# With phase validation
cf-expr-lint -e 'http.response.code eq 200' -p http_request_firewall_custom
# ✗ [field-not-in-phase]: Field "http.response.code" is not available in phase "http_request_firewall_custom"

# From stdin
echo '(ip.src.country in {"US" "JP"})' | cf-expr-lint --stdin
```

### Auto-fix expressions

```bash
# Fix a single expression
cf-expr-lint --fix -e 'not (http.cookie eq "a" or http.cookie eq "b")'
# Output: (not http.cookie eq "a" and not http.cookie eq "b")

# Fix all expressions in YAML files
cf-expr-lint --fix --config .cf-expr-lint.json config/**/*.yaml

# Dry-run — check if fixes are needed (exits non-zero if so)
cf-expr-lint --fix --check config/**/*.yaml
```

The fixer applies these transformations:
- Wrap bare expressions: `A eq B` → `(A eq B)`
- Merge and-groups: `(A) and (B)` → `(A and B)`
- Remove outer parens from or-chains: `((A) or (B))` → `(A) or (B)`
- Wrap or-branches: `A or B` → `(A) or (B)`
- Unwrap individually-wrapped and-conditions: `((A) and (B))` → `(A and B)`
- De Morgan's law: `not (A or B)` → `(not A and not B)`
- Operator style: `==` → `eq`, `<=` → `le`, `&&` → `and`, etc.

### Prettify expressions

```bash
# Format a single expression
cf-expr-lint --prettify -e '(http.host eq "test.com" and http.request.method eq "POST" and not ip.src in $blocklist)'

# Prettify all YAML files (rewrites in-place with >- block scalars)
cf-expr-lint --prettify --config .cf-expr-lint.json config/**/*.yaml

# Also convert existing | and |- block scalars to >-
cf-expr-lint --prettify --convert-block-scalars config/**/*.yaml

# Custom max line width (default: 120)
cf-expr-lint --prettify --max-width 100 config/**/*.yaml

# Dry-run — check if formatting is needed
cf-expr-lint --prettify --check config/**/*.yaml
```

Before:
```yaml
expression: (http.host eq "example.com" and http.request.method eq "POST" and not ip.src in $blocklist and http.request.uri.path eq "/api/webhook")
```

After:
```yaml
expression: >-
  (
    http.host eq "example.com"
    and http.request.method eq "POST"
    and not ip.src in $blocklist
    and http.request.uri.path eq "/api/webhook"
  )
```

### Custom YAML key mappings (CLI)

By default, the scanner only looks for the `expression` key (the standard
Cloudflare Terraform provider attribute). If your YAML uses other key
names for expressions, tell the scanner about them:

```bash
cf-expr-lint \
  --expr-key rewrite_expression:rewrite_url:http_request_transform \
  --expr-key source_url_expression:filter:http_request_dynamic_redirect \
  --phase-map waf_rules:http_request_firewall_custom \
  config/**/*.yaml
```

### Config file

For projects with many custom mappings, use a `.cf-expr-lint.json` config file:

```json
{
  "expressionKeys": {
    "rewrite_expression": { "type": "rewrite_url", "phaseHint": "http_request_transform" },
    "source_url_expression": { "type": "filter", "phaseHint": "http_request_dynamic_redirect" }
  },
  "phaseMappings": {
    "waf_rules": "http_request_firewall_custom",
    "custom_rules": "http_request_firewall_custom",
    "ratelimit_rules": "http_ratelimit"
  },
  "accountLevelPaths": ["config/account/"],
  "ignoreCodes": ["contains-placeholders"],
  "operatorStyle": "english"
}
```

### CLI Options

| Option | Short | Description |
|--------|-------|-------------|
| `--expression` | `-e` | Validate a single expression string |
| `--stdin` | | Read expression from stdin |
| `--type` | `-t` | Expression type: `filter` (default), `rewrite_url`, `rewrite_header`, `redirect_target` |
| `--phase` | `-p` | Cloudflare phase for field validation |
| `--config` | `-c` | Path to config file (JSON) with custom mappings |
| `--expr-key` | | Add expression key mapping: `key:type[:phase]` (repeatable) |
| `--phase-map` | | Add phase mapping: `yaml_key:phase` (repeatable) |
| `--format` | `-f` | Output format: `text` (default), `json` |
| `--quiet` | `-q` | Only show errors (suppress warnings) |
| `--warn-exit-code` | | Exit code when warnings found (default: 0, use 2 for CI) |
| `--ignore-code` | | Suppress a diagnostic code repo-wide (repeatable). For per-expression suppression, use [inline directives](#inline-disable-directives). |
| `--operator-style` | | Operator style: `english` (default), `clike`, `off` |
| `--fix` | | Auto-fix expressions for Builder compatibility |
| `--prettify` | | Reformat long expressions as multi-line `>-` block scalars |
| `--convert-block-scalars` | | Convert `\|` and `\|-` to `>-` (use with `--prettify`) |
| `--max-width` | | Max line width for `--prettify` (default: 120) |
| `--check` | | Dry-run for `--fix` or `--prettify` (exits 1 if changes needed) |
| `--help` | `-h` | Show help |

## Inline Disable Directives

Suppress diagnostics from inside YAML files, in addition to the repo-wide `--ignore-code` / `ignoreCodes` config option. All directives accept an optional comma- or space-separated list of diagnostic codes; omit the codes to suppress every code in scope.

### Whole file

```yaml
# cf-expr-lint-disable-file unknown-field

rules:
  - expression: '(http.totally_made_up eq "x")'
```

### Block

```yaml
rules:
  - expression: '(http.host eq "a")'   # checked

# cf-expr-lint-disable unknown-field
  - expression: '(http.bogus eq "b")'  # suppressed
  - expression: '(http.bogus eq "c")'  # suppressed
# cf-expr-lint-enable

  - expression: '(http.host eq "d")'   # checked
```

An unterminated `disable` block runs to end-of-file.

### Next line (works inside `>-` block scalars)

```yaml
rules:
  # cf-expr-lint-disable-next-line unknown-field
  - expression: >-
      (http.totally_made_up eq "x")
      and (http.request.uri.path eq "/foo")
```

When the line following a `disable-next-line` is an expression key (e.g. `expression:`, or a custom key configured via `expressionKeys`), the suppression covers the entire value, including every line of a `>-` block scalar. This is the form to reach for when a multi-line expression triggers a diagnostic.

Blank lines and additional comment lines between the directive and the expression key are skipped.

### Same line

```yaml
rules:
  - expression: '(http.totally_made_up eq "x")'  # cf-expr-lint-disable-line unknown-field
```

Use this for inline single-line expression values where a trailing comment is the most readable form.

## Expression Builder Compatibility

The Cloudflare Expression Builder UI requires expressions in a specific format:

**Compatible:**
- Single group: `(A and B and C)`
- Or-chain: `(A) or (B and C) or (D)`
- Not toggle: `(not A and not B)`
- Functions: `(starts_with(field, "val"))`, `(ends_with(field, "val"))`

**Not compatible (with suggested rewrites):**
- `(A) and (B)` → merge: `(A and B)`
- `(A or B)` → split: `(A) or (B)`
- `not (A)` → move inside: `(not A)`
- `not (A or B)` → De Morgan's: `(not A and not B)`
- `((A) or (B))` → remove outer: `(A) or (B)`
- `((A) and (B))` → unwrap: `(A and B)`

Use `--fix` to apply these automatically.

## CI/CD Integration

### GitLab CI

```yaml
lint-expressions:
  stage: validate
  image: node:20
  script:
    - npm install -g cloudflare-expression-lint@latest
    - cf-expr-lint --warn-exit-code 2 --config .cf-expr-lint.json $(find config -name "*.yaml" -o -name "*.yml")
    - cf-expr-lint --fix --check --config .cf-expr-lint.json $(find config -name "*.yaml" -o -name "*.yml")
    - cf-expr-lint --prettify --check --config .cf-expr-lint.json $(find config -name "*.yaml" -o -name "*.yml")
  allow_failure:
    exit_codes: [2]
```

### GitHub Actions

```yaml
- name: Lint Cloudflare expressions
  run: |
    npm install -g cloudflare-expression-lint@latest
    cf-expr-lint --warn-exit-code 2 config/**/*.yaml
    cf-expr-lint --fix --check config/**/*.yaml
    cf-expr-lint --prettify --check config/**/*.yaml
```

## Programmatic API

```typescript
import { validate, parse, fixExpression, formatExpression } from 'cloudflare-expression-lint';

// Validate
const result = validate('(http.host eq "example.com")', {
  expressionType: 'filter',
  phase: 'http_request_firewall_custom',
});

// Auto-fix
const fixed = fixExpression('not (http.cookie eq "a" or http.cookie eq "b")');
console.log(fixed.expression); // '(not http.cookie eq "a" and not http.cookie eq "b")'

// Prettify
const pretty = formatExpression('(A and B and C)', { maxWidth: 40 });
```

## Diagnostic Codes

| Code | Severity | Description |
|------|----------|-------------|
| `parse-error` | error | Syntax error in expression |
| `unknown-field` | error | Field name not recognized |
| `unknown-function` | error | Function name not recognized |
| `field-not-in-phase` | error | Field not available in the specified Cloudflare phase |
| `function-not-in-context` | error | Function not available in the expression context |
| `function-max-exceeded` | error | Function used more times than allowed |
| `operator-type-mismatch` | error | Operator not compatible with field type |
| `invalid-cidr-mask` | error | CIDR mask out of valid range |
| `deprecated-field` | warning | Field is deprecated; replacement suggested |
| `expression-too-long` | warning | Expression exceeds 4096 character limit |
| `ambiguous-precedence` | warning | Mixed `and`/`or` without explicit grouping |
| `expression-whitespace` | warning | Leading or trailing whitespace |
| `missing-zone-plan-filter` | warning | Account-level expression missing ENT suffix |
| `empty-in-list` | warning | Empty `in {}` will never match |
| `too-many-regex` | warning | More than 64 regex patterns |
| `header-key-not-lowercase` | warning | Header map key should be lowercase |
| `invalid-wildcard-pattern` | warning | Wildcard contains `**` |
| `builder-incompatible` | info | Not in Expression Builder format |
| `prefer-english-operator` | info | Suggests English notation (`eq`, `and`) |
| `prefer-clike-operator` | info | Suggests C-like notation (`==`, `&&`) |
| `prefer-bare-boolean` | info | Prefer `ssl` over `ssl == true` |

## Architecture

```
src/
├── lexer.ts          # Tokenizer: string → Token[]
├── parser.ts         # Parser: Token[] → AST (recursive descent)
├── validator.ts      # Validator: AST → Diagnostic[] (semantic analysis)
├── fixer.ts          # Auto-fixer: AST → AST (Builder compatibility transforms)
├── formatter.ts      # Prettifier: AST → multi-line string
├── rewriter.ts       # YAML rewriter: replaces expressions in files
├── yaml-scanner.ts   # YAML file scanner with configurable phase inference
├── eslint-plugin.ts  # ESLint plugin adapter (optional)
├── cli.ts            # CLI entry point
├── types.ts          # Shared type definitions
├── index.ts          # Public API exports
└── schemas/
    ├── fields.ts     # 211+ field definitions
    ├── functions.ts  # 25+ function definitions
    └── operators.ts  # Operator type constraints
```

## License

MIT
