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

### Custom YAML key mappings (CLI)

By default, the scanner only looks for the `expression` key (the standard
Cloudflare Terraform provider attribute). If your YAML uses other key
names for expressions, tell the scanner about them:

```bash
# Add custom expression keys and phase mappings via flags
cf-expr-lint \
  --expr-key rewrite_expression:rewrite_url:http_request_transform \
  --expr-key source_url_expression:filter:http_request_dynamic_redirect \
  --phase-map waf_rules:http_request_firewall_custom \
  --phase-map transform_rules:http_request_late_transform \
  config/**/*.yaml
```

The `--expr-key` format is `key_name:expression_type[:phase]`.
The `--phase-map` format is `yaml_parent_key:cloudflare_phase`.

Both merge with the built-in defaults — your custom mappings extend them,
they don't replace them.

### Config file

For projects with many custom mappings, use a `.cf-expr-lint.json` config
file in your project root (auto-detected) or specified with `--config`:

```json
{
  "expressionKeys": {
    "rewrite_expression": { "type": "rewrite_url", "phaseHint": "http_request_transform" },
    "source_url_expression": { "type": "filter", "phaseHint": "http_request_dynamic_redirect" },
    "target_url_expression": { "type": "redirect_target", "phaseHint": "http_request_dynamic_redirect" }
  },
  "phaseMappings": {
    "waf_rules": "http_request_firewall_custom",
    "custom_rules": "http_request_firewall_custom",
    "configuration_rules": "http_config_settings",
    "transform_request_header_rules": "http_request_late_transform",
    "transform_response_header_rules": "http_response_headers_transform",
    "transform_url_rewrite_rules": "http_request_transform"
  }
}
```

Then just run: `cf-expr-lint config/**/*.yaml`

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
- **Raw Strings**: `r"value"`, `r#"value"#` — no escape processing, useful for regex
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
| `invalid-wildcard-pattern` | warning | Wildcard contains `**` (prohibited) |
| `empty-in-list` | warning | Empty `in {}` list will never match |
| `too-many-regex` | warning | More than 64 regex patterns per expression |
| `prefer-bare-boolean` | info | Prefer `ssl` over `ssl == true` |

## How Mappings Work

The scanner needs to know two things about each YAML file:

1. **Which keys contain expressions?** — By default, only `expression` (the Terraform attribute name).
2. **What Cloudflare phase does an expression belong to?** — Inferred from YAML parent keys.

Both are **extensible** — your custom mappings always merge with the built-in
defaults. You never lose the defaults unless you explicitly opt out.

### Programmatic API

```typescript
import { scanYaml } from 'cloudflare-expression-lint';

const result = scanYaml(yamlContent, 'config.yaml', {
  // These MERGE with the built-in defaults
  expressionKeys: {
    'rewrite_expression': { type: 'rewrite_url', phaseHint: 'http_request_transform' },
    'source_url_expression': { type: 'filter', phaseHint: 'http_request_dynamic_redirect' },
  },
  phaseMappings: {
    'waf_rules': 'http_request_firewall_custom',
    'my_transform_rules': 'http_request_transform',
  },
});

// Inspect defaults
import { getDefaultExpressionKeys, getDefaultPhaseMappings } from 'cloudflare-expression-lint';
console.log(getDefaultExpressionKeys()); // { expression: { type: 'filter' } }
console.log(getDefaultPhaseMappings());  // { cache_rules: '...', http_request_firewall_custom: '...', ... }
```

### Built-in Phase Mappings

The defaults include all Cloudflare phase names as self-mappings plus common shorthands:

| YAML Key | Phase |
|----------|-------|
| `http_request_firewall_custom` | `http_request_firewall_custom` |
| `http_ratelimit` | `http_ratelimit` |
| `http_request_cache_settings` | `http_request_cache_settings` |
| `http_request_transform` | `http_request_transform` |
| `http_request_late_transform` | `http_request_late_transform` |
| `http_response_headers_transform` | `http_response_headers_transform` |
| `cache_rules` | `http_request_cache_settings` |
| `rate_limit_rules` | `http_ratelimit` |
| `single_redirects` | `http_request_dynamic_redirect` |
| `origin_rules` | `http_request_origin` |

If you need to **replace** all defaults instead of merging, pass
`replaceExpressionKeys: true` or `replacePhaseMappings: true`.

### ESLint Plugin

```javascript
// eslint.config.js (flat config)
import cfExprLint from 'cloudflare-expression-lint/eslint-plugin';

export default [
  {
    files: ['config/**/*.yaml'],
    plugins: { 'cf-expr': cfExprLint },
    rules: {
      'cf-expr/validate-expression': ['error', {
        // Custom mappings (merged with defaults)
        customKeyMappings: {
          'rewrite_expression': 'rewrite_url',
          'source_url_expression': 'filter',
        },
        customPhaseMappings: {
          'waf_rules': 'http_request_firewall_custom',
        },
      }],
    },
  },
];
```

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

## Publishing

Publish to npm automatically by bumping the version:

```bash
npm version patch    # or minor / major
git push && git push --tags
```

Pushing a `v*` tag triggers the GitHub Actions workflow which builds,
tests, and publishes to npm via OIDC Trusted Publishing (no tokens needed).

## Architecture

```
src/
├── lexer.ts          # Tokenizer: string → Token[]
├── parser.ts         # Parser: Token[] → AST (recursive descent)
├── validator.ts      # Validator: AST → Diagnostic[] (semantic analysis)
├── yaml-scanner.ts   # YAML file scanner with configurable phase inference
├── eslint-plugin.ts  # ESLint plugin adapter (optional)
├── cli.ts            # CLI entry point with config file support
├── types.ts          # Shared type definitions
├── index.ts          # Public API exports
└── schemas/
    ├── fields.ts     # 211+ field definitions with deprecation tracking
    ├── functions.ts  # 25+ function definitions with context restrictions
    └── operators.ts  # Operator definitions with type constraints
```

## License

MIT
