# Changelog

All notable changes to this project will be documented in this file.

## [0.14.2] - 2026-08-17

### Fixed
- **Single-line expressions are written inline instead of in a `>-` block.** The rewriter emitted a block scalar for every replacement, so wrapping a short expression produced a two-line `>-` holding one line, which costs a line and buys nothing. A block scalar is now used only when the formatted output actually wraps.
- Inline output prefers plain style, falls back to single quotes so backslashes in regex literals never need escaping, and uses double quotes only when the value contains a single quote. Round-tripped through a YAML parser in tests to confirm the emitted scalar reads back byte-identical, including values with `: `, ` #`, IPv6 colons, and mixed quotes.
- `inlineScalar` exported for callers building their own YAML output.

## [0.14.1] - 2026-08-17

### Fixed
- **`--fix` no longer reformats expressions it did not fix.** Fix mode passed `convertBlockScalars: true` into the rewriter unconditionally, which made every expression in a file eligible for reformatting as soon as one expression in it needed a fix. On a real file, fixing 11 expressions rewrote 38 of 77, and the reformatted values were not equal to the originals: the rewriter emits indented `>-` block scalars, and YAML folding preserves newlines on more-indented lines, so the stored string gained embedded `\n` and spaces. Semantically identical to Cloudflare, but a different string, which means a Terraform plan diff on rules nobody touched. Expressions without a fix are now left byte-identical. `--fix --prettify` still reformats everything, which is what it is for.
- New `RewriteOptions.onlyReplacements` for programmatic callers that need the same guarantee.

## [0.14.0] - 2026-08-17

### Added
- **`--fix-only <code>`** restricts `--fix` to one diagnostic code, repeatable. `--fix` applied all 16 rewrites with no way to select, which put the always-safe parenthesis wraps behind the same flag as De Morgan rewrites and or-branch restructuring. On a real repo that meant asking for 12 wraps and being offered 46 changes across 8 files, so the flag could not be used unattended or in CI.
  ```
  cf-expr-lint --fix --fix-only builder-unwrapped config/**/*.yaml
  ```
  Accepted codes: `builder-unwrapped`, `builder-incompatible`, `negated-comparison`, `prefer-english-operator`, `prefer-clike-operator`, `prefer-in-list`. An unknown code is a hard error rather than a silent no-op, which would otherwise read as a pass under `--check`.
- `FIXABLE_CODES` and `FixOptions.fixOnly` exported for programmatic callers.

### Fixed
- A scoped run now touches only expressions the checker actually reports with that code. The fixer's own predicates were broader than the validator's in two places: it wrapped comparisons with a function on the left, which the Builder check skips entirely, and it treated any `not` leaf as a simple condition where the check requires `not` of a Builder condition. Both meant `--fix --check --fix-only builder-unwrapped` could fail on expressions that produced no warning. Unscoped `--fix` behaviour is unchanged.

### Notes
Default `--fix` still applies everything. Making the safe subset the default is a breaking change to the flag's meaning and is deliberately not part of this release.

## [0.13.0] - 2026-08-13

### Changed
- **A missing outer wrap is now a `builder-unwrapped` warning** instead of an info-level `builder-incompatible` diagnostic. Three cases move: a bare comparison, in-expression or function call (`http.host eq "a"`), a bare `not` condition (`not http.host eq "a"`), and a bare and-chain (`A and B and C`). These were reported but never surfaced: info diagnostics are excluded from the error and warning counts, so a run containing only them printed `0 errors, 0 warnings` and exited 0, which reads as a pass in CI. All three are always mechanically fixable by `--fix`, unlike the structural checks, so they warrant a status of their own.
- Structural Builder issues (`or` nested inside `and`, and between groups, De Morgan candidates) keep `builder-incompatible` at info. They often have no safe automatic rewrite, so promoting them would produce permanent noise.

### Upgrade note
With `--warn-exit-code 2`, a previously silent unwrapped expression now exits 2. Suppress with `--ignore-code builder-unwrapped` or `"ignoreCodes": ["builder-unwrapped"]`, which leaves the info-level checks in place.

## [0.12.1] - 2026-07-29

### Fixed
- **Escaped-newline scalars are now detected and normalized.** An expression written as a double-quoted YAML scalar with embedded `\n` escapes (`expression: "(\n  http.host eq \"example.com\"\n)"`) was invisible to the rewriter: the locator unescaped `\"` and `\\` but not `\n`, so the value never matched and `findExpressionLocation` returned `null`. `--fix`, `--prettify` and `--convert-block-scalars` were all silent no-ops on this pattern, which let it spread unnoticed. Such scalars are now located, reported, and rewritten to inline (short) or `>-` (long), preserving the stored value exactly.
- **`--fix --prettify` now applies both** instead of behaving as `--fix` alone. Fix mode exited before prettify mode could run, and only rewrote files that had a semantic fix, so files needing only formatting were left untouched and the combination silently under-reported. `--check` now reports fix and format counts separately and exits 1 if either has work.

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
