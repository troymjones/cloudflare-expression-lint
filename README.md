# cloudflare-expression-lint

A parser, validator, and linter for [Cloudflare Rules Language](https://developers.cloudflare.com/ruleset-engine/rules-language/) expressions with phase-aware field and function checking.

Catches errors **before** `terraform apply` — no API calls required.

## Features

- **Full expression parser** — lexer + recursive-descent parser for the Cloudflare wirefilter expression syntax
- **211+ known fields** with type information
- **Deprecated field detection** — warns on legacy fields like `ip.geoip.country` with replacement suggestions
- **Phase-aware validation** — knows which fields are available in which Cloudflare phase (e.g., response fields only in response phases)
- **Function context validation** — `regex_replace()` is only valid in rewrite/redirect contexts, not filter expressions
- **Function usage limits** — enforces max 1 `regex_replace()` / `wildcard_replace()` per expression
- **YAML scanner** — auto-detects expressions in YAML config files and infers the Cloudflare phase from context
- **CLI tool** — validate expressions from the command line or CI/CD pipelines
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

### CLI Options

| Option | Short | Description |
|--------|-------|-------------|
| `--expression` | `-e` | Validate a single expression string |
| `--stdin` | | Read expression from stdin |
| `--type` | `-t` | Expression type: `filter` (default), `rewrite_url`, `rewrite_header`, `redirect_target` |
| `--phase` | `-p` | Cloudflare phase for field validation |
| `--format` | `-f` | Output format: `text` (default), `json` |
| `--quiet` | `-q` | Only show errors (suppress warnings) |
| `--help` | `-h` | Show help |

## Programmatic API

```typescript
import { validate, parse, tokenize } from 'cloudflare-expression-lint';

// Validate an expression
const result = validate('(http.host eq "example.com")', {
  expressionType: 'filter',
  phase: 'http_request_firewall_custom',
});

console.log(result.valid);       // true
console.log(result.diagnostics); // []

// Validate with warnings
const result2 = validate('(ip.geoip.country eq "US")', {
  expressionType: 'filter',
});
// result2.valid === true (warnings don't make it invalid)
// result2.diagnostics[0].code === 'deprecated-field'
// result2.diagnostics[0].message === 'Field "ip.geoip.country" is deprecated. Use "ip.src.country" instead'

// Parse to AST
const ast = parse('http.host eq "example.com"');
console.log(ast.kind); // 'Comparison'

// Tokenize
const tokens = tokenize('http.host eq "example.com"');
```

### YAML Scanner

```typescript
import { scanYaml } from 'cloudflare-expression-lint/yaml-scanner';
import { readFileSync } from 'fs';

const content = readFileSync('config/zones/example.yaml', 'utf-8');
const result = scanYaml(content, 'example.yaml');

for (const expr of result.expressions) {
  if (!expr.result.valid) {
    console.error(`${expr.file} → ${expr.yamlPath}: ${expr.result.diagnostics[0].message}`);
  }
}
```

## Supported Expression Syntax

This tool supports the full Cloudflare Rules Language syntax:

### Operators

| Type | English | C-like |
|------|---------|--------|
| Equal | `eq` | `==` |
| Not equal | `ne` | `!=` |
| Less than | `lt` | `<` |
| Less/equal | `le` | `<=` |
| Greater than | `gt` | `>` |
| Greater/equal | `ge` | `>=` |
| Contains | `contains` | |
| Wildcard | `wildcard` | |
| Strict wildcard | `strict wildcard` | |
| Regex match | `matches` | `~` |
| Set membership | `in` | |
| AND | `and` | `&&` |
| OR | `or` | `\|\|` |
| NOT | `not` | `!` |
| XOR | `xor` | `^^` |

### Value Types

- **Strings**: `"value"` with `\"` and `\\` escaping
- **Integers**: `42`, `0`, `396507`
- **Booleans**: `true`, `false`
- **IP Addresses**: `1.2.3.4`, with CIDR (`1.2.3.0/24`) in `in` lists
- **Named Lists**: `$list_name`, `$cf.malware`
- **In-lists**: `{"US" "JP"}`, `{8000..8009}`, `{1.2.3.0/24}`

### Functions

All standard Cloudflare functions are supported, with context-aware validation:

| Function | Available In |
|----------|-------------|
| `lower()`, `upper()`, `len()`, `starts_with()`, `ends_with()`, `contains()` | All contexts |
| `concat()`, `substring()`, `url_decode()` | All contexts |
| `any()`, `all()`, `has_key()`, `has_value()` | All contexts |
| `lookup_json_string()`, `lookup_json_integer()` | All contexts |
| `regex_replace()` | Rewrite, redirect (max 1 per expression) |
| `wildcard_replace()` | Rewrite, redirect (max 1 per expression) |
| `to_string()`, `encode_base64()`, `uuidv4()`, `sha256()` | Rewrite/transform only |
| `cidr()`, `cidr6()` | Filter only |

## Diagnostic Codes

| Code | Severity | Description |
|------|----------|-------------|
| `parse-error` | error | Syntax error in expression |
| `unknown-field` | error | Field name not recognized |
| `unknown-function` | error | Function name not recognized |
| `field-not-in-phase` | error | Field not available in the specified Cloudflare phase |
| `function-not-in-context` | error | Function not available in the expression context (filter vs rewrite) |
| `function-max-exceeded` | error | Function used more times than allowed |
| `operator-type-mismatch` | error | Operator not compatible with field type (e.g., `contains` on IP) |
| `deprecated-field` | warning | Field is deprecated; replacement suggested |
| `expression-too-long` | warning | Expression exceeds 4096 character limit |
| `header-key-not-lowercase` | warning | Header map key should be lowercase |
| `invalid-list-name` | warning | Named list name doesn't match Cloudflare naming rules |
| `invalid-cidr-mask` | error | CIDR mask out of valid range |
| `prefer-bare-boolean` | info | Prefer `ssl` over `ssl == true` |

## YAML Scanner

The YAML scanner detects `expression` keys (the standard Cloudflare Terraform provider attribute name) by default. Phase is inferred from YAML parent keys that match Cloudflare phase names (e.g., `http_request_firewall_custom`, `cache_rules`).

### Custom Mappings

Since every team structures their YAML differently, the scanner accepts custom key and phase mappings:

```typescript
import { scanYaml } from 'cloudflare-expression-lint';

const result = scanYaml(yamlContent, 'config.yaml', {
  // Add custom expression keys (merged with default 'expression')
  expressionKeys: {
    'rewrite_expression': { type: 'rewrite_url', phaseHint: 'http_request_transform' },
    'source_url_expression': { type: 'filter', phaseHint: 'http_request_dynamic_redirect' },
    'target_url_expression': { type: 'redirect_target', phaseHint: 'http_request_dynamic_redirect' },
    'my_custom_filter': { type: 'filter' },
  },

  // Add custom YAML key → phase mappings (merged with defaults)
  phaseMappings: {
    'waf_rules': 'http_request_firewall_custom',
    'my_transform_rules': 'http_request_transform',
  },
});
```

### Built-in Phase Mappings

The built-in defaults only include Cloudflare phase names used as YAML keys and a few common shorthands:

| YAML Key | Phase |
|----------|-------|
| `http_request_firewall_custom` | `http_request_firewall_custom` |
| `http_ratelimit` | `http_ratelimit` |
| `http_request_cache_settings` | `http_request_cache_settings` |
| `http_request_transform` | `http_request_transform` |
| `cache_rules` | `http_request_cache_settings` |
| `rate_limit_rules` | `http_ratelimit` |
| `single_redirects` | `http_request_dynamic_redirect` |
| `origin_rules` | `http_request_origin` |
| ...and all other `http_*` phase names | *(self-mapping)* |

To use entirely custom mappings: `{ replacePhaseMappings: true, phaseMappings: { ... } }`

## CI/CD Integration

### GitLab CI

```yaml
lint-expressions:
  stage: validate
  script:
    - npx cloudflare-expression-lint config/**/*.yaml
  allow_failure: false
```

### GitHub Actions

```yaml
- name: Lint Cloudflare expressions
  run: npx cloudflare-expression-lint config/**/*.yaml
```

### Pre-commit Hook

```bash
#!/bin/sh
npx cloudflare-expression-lint $(git diff --cached --name-only --diff-filter=ACM -- '*.yaml' '*.yml')
```

## Extending the Schema

The field and function registries are defined in TypeScript files under `src/schemas/`:

- **`fields.ts`** — All known fields with types, deprecation status, and phase availability
- **`functions.ts`** — All known functions with parameter types, return types, context restrictions, and usage limits
- **`operators.ts`** — All comparison and logical operators with type constraints

To add a new field or function, edit the relevant schema file and add a new entry to the array. The tool will automatically pick it up.

## Architecture

```
src/
├── lexer.ts          # Tokenizer: string → Token[]
├── parser.ts         # Parser: Token[] → AST (recursive descent)
├── validator.ts      # Validator: AST → Diagnostic[] (semantic analysis)
├── yaml-scanner.ts   # YAML file scanner with phase inference
├── cli.ts            # CLI entry point
├── types.ts          # Shared type definitions
├── index.ts          # Public API exports
└── schemas/
    ├── fields.ts     # 211+ field definitions
    ├── functions.ts  # 25+ function definitions
    └── operators.ts  # Operator definitions
```

## License

MIT
