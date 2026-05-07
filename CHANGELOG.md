# Changelog

All notable changes to this project will be documented in this file.

## [0.12.0] - 2026-05-07

### Added
- **Inline disable directives** for suppressing diagnostics from within YAML files, in addition to the existing repo-wide `--ignore-code` / `ignoreCodes` config option. Four standard scopes are supported, each accepting an optional comma- or space-separated list of diagnostic codes (omit codes to suppress all):
  - `# cf-expr-lint-disable-file [codes]` — whole file.
  - `# cf-expr-lint-disable [codes]` … `# cf-expr-lint-enable [codes]` — block between the two directives.
  - `# cf-expr-lint-disable-next-line [codes]` — next non-blank, non-comment line. When that line is an expression key (`expression: >-`, etc.), the suppression covers the entire value, including all lines of a `>-` block scalar.
  - `# cf-expr-lint-disable-line [codes]` — same line as the directive (intended as a trailing comment on inline expression values).
- `analyzeDirectives` and `isLineSuppressed` exported from the public API for consumers that want to apply the same filtering programmatically.

## [0.11.1] - 2026-04-23

### Fixed
- Validator now substitutes template placeholders before parsing, matching the behavior of the fixer and formatter. Previously, expressions with placeholders in positions where only literals are valid (e.g., `any(field[*] in {__PLACEHOLDER__})`) triggered a `parse-error-placeholder` warning, and placeholders in RHS positions (e.g., `http.host eq __PLACEHOLDER__`) triggered an `unknown-field` error that would hard-fail CI. Both cases now parse and validate structurally, with the existing `contains-placeholders` info message preserved to signal that content-level checks can't fully verify placeholder-replaced values.

## [0.11.0] - 2026-04-22

### Added
- **`value-domain-path`** (warning) — flags `http.request.uri.path` literal comparisons where the value doesn't start with `/`. Cloudflare paths always start with `/`, so these comparisons never match (dead code).
- **`value-domain-path-regex`** (warning) — flags literal path values containing regex metacharacters (`^/`, `.*`, `.+`, `\d`, `\w`, `\s`, trailing `$`) when used with non-regex operators like `eq`/`ne`/`in`. Catches the class of bug where authors write `path ne "^/api.*"` thinking `ne` interprets regex. Raw strings (`r"..."`) are intentionally skipped since they're explicit regex intent.

## [0.9.0] - 2026-04-22

### Added
- **`illogical-condition`** (warning) — detects `A eq X and A eq Y` (always false) and `A ne X or A ne Y` (always true) where X and Y are distinct literals on the same field.
- **`duplicate-list-entries`** (warning) — detects repeated values inside `in { ... }` lists.
- **`negated-comparison`** (info, auto-fixable) — detects `not A eq X` and `not A ne X`; `--fix` rewrites to `A ne X` / `A eq X`. The rewrite cascades through De Morgan's, producing cleaner Builder-compatible output.
- **`value-domain-method`** (warning) — HTTP methods must be uppercase ASCII letters.
- **`value-domain-country`** (warning) — country codes must be 2-letter uppercase ISO-3166 (plus `T1`, `XX`).
- **`value-domain-continent`** (warning) — must be one of `AF AN AS EU NA OC SA T1`.
- **`value-domain-port`** (warning) — port fields must be 0–65535.

### Changed
- Fixer now simplifies `(not A eq X)` to `(A ne X)` as part of the main auto-fix loop. Existing tests updated to reflect the cleaner output.

## [0.8.6] - 2026-04-16

### Fixed
- Map field key access (e.g. `http.request.headers["accept"]`) now resolves to `Array`, not `String`. This catches invalid expressions like `http.request.headers["accept"] contains "text/html"` as `operator-type-mismatch`. Cloudflare's Rules engine treats Map values as `Array<String>`, so a further `[0]` or `[*]` is required to get a String.

## [0.8.1] - 2026-03-26

### Fixed
- Headers `expression` key inside transform rules no longer double-counted as filter expression

## [0.8.0] - 2026-03-26

### Changed
- Extracted shared AST utilities into `ast-utils.ts` (removes code duplication)
- Extracted `findExpressionLocation` into `yaml-locator.ts` with configurable expression keys
- Split `validator.ts` (1,117 → 660 lines) into `builder-compat.ts` and `template-detection.ts`
- Exported `printNode`, `normalizeOp`, `collectChain`, `stripGroup` from public API

### Added
- 134 new tests: CLI integration, convergence suite, schema completeness, YAML edge cases, error handling
- Test fixtures for CLI integration testing

## [0.7.2] - 2026-03-26

### Fixed
- **De Morgan's `not (A and B)` produced bare `or` inside `and` chains**, changing expression semantics. The or-chain result is now wrapped in a group.

## [0.7.1] - 2026-03-26

### Added
- Auto-fix: collapse `or`-chains of 3+ `eq` comparisons on the same field into `in`-lists
- YAML locator handles values that start on the line after the key

### Fixed
- Fixer iterates internally so chained fixes (e.g., Builder restructuring exposing or-eq patterns) converge in a single pass

## [0.7.0] - 2026-03-26

### Changed
- Default `maxWidth` lowered from 120 to 100 to account for YAML indentation (~20 chars)

## [0.6.1] - 2026-03-26

### Added
- `legacy-placeholder-format` diagnostic: suggests `__NAME__` format over bare `UPPER_CASE`
- Tests updated to use `__NAME__` convention by default

## [0.6.0] - 2026-03-26

### Added
- In-lists exceeding `maxWidth` now break to one value per line
- `long-in-list` info diagnostic at 10+ items, suggests named lists
- `--max-in-list-items` CLI flag and `maxInListItems` config option

## [0.5.7] - 2026-03-26

### Fixed
- Account-level expressions now produce `((inner)) and (cf.zone.plan eq "ENT")` (double-wrap required by Cloudflare Expression Builder)

## [0.5.6] - 2026-03-26

### Added
- Placeholder pre-processing: expressions with `__NAME__` or `UPPER_CASE` template variables inside set literals are now parseable, formattable, and fixable
- Length-matched synthetic values for correct `maxWidth` decisions

### Fixed
- Rewriter `existingBlock` comparison used original content instead of modified, causing false-positive rewrites
- Block scalar `lineEnd` included trailing blank lines, causing oscillation

## [0.5.4] - 2026-03-25

### Fixed
- Fixer no longer merges `(cf.zone.plan eq "ENT")` suffix into the main group (breaks account-level validation)

## [0.5.2] - 2026-03-25

### Fixed
- Formatter recursively breaks nested Groups and Not nodes exceeding `maxWidth`

## [0.5.1] - 2026-03-25

### Fixed
- **Convergence fix**: `--fix` now routes through `rewriteExpressions` (same code path as `--prettify`), eliminating oscillation between the two commands
- `findExpressionLocation` handles CRLF files, YAML escaped double quotes, and plain multi-line values

## [0.5.0] - 2026-03-21

### Added
- `--prettify` command for multi-line expression formatting with `>-` block scalars
- `--convert-block-scalars` to convert `|` and `|-` to `>-`
- `--check` dry-run mode for CI enforcement

## [0.4.7] - 2026-03-20

### Fixed
- Builder-compat wrapping skipped for rewrite/redirect expression types

## [0.4.0] - 2026-03-19

### Added
- `--fix` auto-fixer: wraps bare expressions, merges and-groups, De Morgan's rewrites, operator style normalization
- `--operator-style` flag (english/clike/off)

## [0.3.0] - 2026-03-18

### Added
- ESLint plugin adapter with `cloudflare-expression-lint/validate-expression` rule
- Configurable expression keys and phase mappings via `.cf-expr-lint.json`

## [0.2.0] - 2026-03-17

### Added
- Account-level zone plan filter validation
- Expression Builder compatibility checking
- Ambiguous operator precedence warnings
- Load balancing and DNS field support
- Automated Cloudflare docs sync (weekly GitHub Action)

## [0.1.0] - 2026-03-16

### Added
- Initial release: parser, validator, and CLI
- Phase-aware field and function checking
- Operator type checking
- `--warn-exit-code` for CI integration
- OIDC Trusted Publishing on npm
