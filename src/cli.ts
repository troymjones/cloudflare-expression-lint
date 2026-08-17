#!/usr/bin/env node

/**
 * CLI for cloudflare-expression-lint.
 *
 * Usage:
 *   cf-expr-lint [options] <files...>
 *   cf-expr-lint --expression "http.host eq \"test.com\""
 *   cf-expr-lint --config .cf-expr-lint.json config/**\/*.yaml
 *
 * Options:
 *   --expression, -e   Validate a single expression string
 *   --stdin             Read expression from stdin
 *   --type, -t          Expression type: filter, rewrite_url, rewrite_header, redirect_target
 *   --phase, -p         Cloudflare phase (e.g., http_request_firewall_custom)
 *   --config, -c        Path to config file (.json) with custom mappings
 *   --expr-key          Add expression key mapping: key:type[:phase]
 *   --phase-map         Add phase mapping: yaml_key:phase_name
 *   --format, -f        Output format: text (default), json
 *   --quiet, -q         Only output errors (suppress warnings)
 *   --help, -h          Show this help message
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { glob } from 'glob';
import { validate } from './validator.js';
import { formatExpression } from './formatter.js';
import { rewriteExpressions } from './rewriter.js';
import { fixExpression, FIXABLE_CODES } from './fixer.js';
import { scanYaml, getDefaultExpressionKeys } from './yaml-scanner.js';
import type { ScannerOptions, ExpressionKeyMapping } from './yaml-scanner.js';
import type { ValidationContext, ExpressionType, OperatorStyle, Diagnostic } from './types.js';
import { analyzeDirectives, isLineSuppressed } from './directives.js';
import type { SuppressionRange } from './directives.js';

interface CLIOptions {
  files: string[];
  expression?: string;
  stdin: boolean;
  type: ExpressionType;
  phase?: string;
  configFile?: string;
  exprKeys: { key: string; type: ExpressionType; phase?: string }[];
  phaseMaps: { yamlKey: string; phase: string }[];
  format: 'text' | 'json';
  quiet: boolean;
  warnExitCode: number;
  ignoreCodes: string[];
  fixOnly: string[];
  operatorStyle: OperatorStyle;
  prettify: boolean;
  fix: boolean;
  check: boolean;
  convertBlockScalars: boolean;
  maxWidth: number;
  maxInListItems: number;
  help: boolean;
}

function parseArgs(argv: string[]): CLIOptions {
  const opts: CLIOptions = {
    files: [],
    stdin: false,
    type: 'filter',
    exprKeys: [],
    phaseMaps: [],
    format: 'text',
    quiet: false,
    warnExitCode: 0,
    ignoreCodes: [],
    fixOnly: [],
    operatorStyle: 'english',
    prettify: false,
    fix: false,
    check: false,
    convertBlockScalars: false,
    maxWidth: 100,
    maxInListItems: 10,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
      case '-v': {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
        console.log(pkg.version);
        process.exit(0);
      }
      case '--expression':
      case '-e':
        opts.expression = argv[++i];
        break;
      case '--stdin':
        opts.stdin = true;
        break;
      case '--type':
      case '-t':
        opts.type = argv[++i] as ExpressionType;
        break;
      case '--phase':
      case '-p':
        opts.phase = argv[++i];
        break;
      case '--config':
      case '-c':
        opts.configFile = argv[++i];
        break;
      case '--expr-key': {
        // Format: key:type[:phase]
        const val = argv[++i];
        const parts = val.split(':');
        if (parts.length >= 2) {
          opts.exprKeys.push({
            key: parts[0],
            type: parts[1] as ExpressionType,
            phase: parts[2],
          });
        }
        break;
      }
      case '--phase-map': {
        // Format: yaml_key:phase_name
        const val = argv[++i];
        const colonIdx = val.indexOf(':');
        if (colonIdx > 0) {
          opts.phaseMaps.push({
            yamlKey: val.substring(0, colonIdx),
            phase: val.substring(colonIdx + 1),
          });
        }
        break;
      }
      case '--format':
      case '-f':
        opts.format = argv[++i] as 'text' | 'json';
        break;
      case '--quiet':
      case '-q':
        opts.quiet = true;
        break;
      case '--warn-exit-code':
        opts.warnExitCode = parseInt(argv[++i], 10);
        break;
      case '--ignore-code':
        opts.ignoreCodes.push(argv[++i]);
        break;
      case '--fix-only':
        opts.fixOnly.push(argv[++i]);
        break;
      case '--operator-style':
        opts.operatorStyle = argv[++i] as OperatorStyle;
        break;
      case '--prettify':
        opts.prettify = true;
        break;
      case '--fix':
        opts.fix = true;
        break;
      case '--convert-block-scalars':
        opts.convertBlockScalars = true;
        break;
      case '--check':
        opts.check = true;
        break;
      case '--max-width':
        opts.maxWidth = parseInt(argv[++i], 10);
        break;
      case '--max-in-list-items':
        opts.maxInListItems = parseInt(argv[++i], 10);
        break;
      default:
        if (!arg.startsWith('-')) {
          opts.files.push(arg);
        }
        break;
    }
    i++;
  }

  return opts;
}

/**
 * Build ScannerOptions from CLI flags and config file.
 */
function buildScannerOptions(opts: CLIOptions): ScannerOptions | undefined {
  const scannerOpts: ScannerOptions = {};
  let hasOptions = false;

  // Load config file if specified (or auto-detect)
  const configPath = opts.configFile ?? findConfigFile();
  if (configPath) {
    try {
      const raw = readFileSync(resolve(configPath), 'utf-8');
      const config = JSON.parse(raw) as {
        expressionKeys?: Record<string, ExpressionKeyMapping>;
        phaseMappings?: Record<string, string>;
        ignoreCodes?: string[];
        accountLevelPaths?: string[];
        operatorStyle?: OperatorStyle;
        maxInListItems?: number;
      };
      if (config.expressionKeys) {
        scannerOpts.expressionKeys = config.expressionKeys;
        hasOptions = true;
      }
      if (config.phaseMappings) {
        scannerOpts.phaseMappings = config.phaseMappings;
        hasOptions = true;
      }
      if (config.ignoreCodes) {
        opts.ignoreCodes.push(...config.ignoreCodes);
      }
      if (config.accountLevelPaths) {
        scannerOpts.accountLevelPaths = config.accountLevelPaths;
        hasOptions = true;
      }
      if (config.operatorStyle) {
        opts.operatorStyle = config.operatorStyle;
      }
      if (config.maxInListItems !== undefined) {
        opts.maxInListItems = config.maxInListItems;
      }
    } catch (err) {
      console.error(`Error reading config file ${configPath}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // Apply --expr-key flags (merge with config file)
  if (opts.exprKeys.length > 0) {
    scannerOpts.expressionKeys = scannerOpts.expressionKeys ?? {};
    for (const ek of opts.exprKeys) {
      scannerOpts.expressionKeys[ek.key] = {
        type: ek.type,
        phaseHint: ek.phase,
      };
    }
    hasOptions = true;
  }

  // Apply --phase-map flags (merge with config file)
  if (opts.phaseMaps.length > 0) {
    scannerOpts.phaseMappings = scannerOpts.phaseMappings ?? {};
    for (const pm of opts.phaseMaps) {
      scannerOpts.phaseMappings[pm.yamlKey] = pm.phase;
    }
    hasOptions = true;
  }

  // Pass operator style to scanner
  if (opts.operatorStyle !== 'english') {
    scannerOpts.operatorStyle = opts.operatorStyle;
    hasOptions = true;
  }

  return hasOptions ? scannerOpts : undefined;
}

/**
 * Auto-detect config file in the current directory.
 */
function findConfigFile(): string | undefined {
  const candidates = [
    '.cf-expr-lint.json',
    '.cf-expr-lint.yaml',
    'cf-expr-lint.config.json',
  ];
  for (const name of candidates) {
    if (existsSync(name)) return name;
  }
  return undefined;
}

function printHelp(): void {
  console.log(`
cloudflare-expression-lint - Validate Cloudflare Rules Language expressions

Usage:
  cf-expr-lint [options] <files...>
  cf-expr-lint -e "http.host eq \\"test.com\\""
  echo 'http.host eq "test"' | cf-expr-lint --stdin

Options:
  --expression, -e <expr>    Validate a single expression string
  --stdin                    Read expression from stdin
  --type, -t <type>          Expression type: filter (default), rewrite_url,
                             rewrite_header, redirect_target
  --phase, -p <phase>        Cloudflare phase for field validation
  --config, -c <file>        Config file with custom mappings (JSON)
  --expr-key <key:type[:phase]>
                             Add a YAML key that contains an expression.
                             Can be specified multiple times.
  --phase-map <yaml_key:phase>
                             Map a YAML parent key to a Cloudflare phase.
                             Can be specified multiple times.
  --format, -f <fmt>         Output format: text (default), json
  --quiet, -q                Only show errors (suppress warnings/info)
  --warn-exit-code <n>       Exit code when warnings found but no errors
                             (default: 0). Use 2 for CI warning status.
  --ignore-code <code>       Suppress a diagnostic code (repeatable).
                             Also configurable via "ignoreCodes" in config file.
                             For per-expression suppression, use inline directive
                             comments (see "Inline Directives" below).
  --operator-style <style>   Operator style: english (default), clike, off.
                             Also configurable via "operatorStyle" in config file.
  --fix                      Auto-fix expressions in YAML files for Builder
                             compatibility (wrap bare exprs, merge and-groups,
                             De Morgan's rewrites, operator style).
  --fix-only <code>          Restrict --fix to one diagnostic code (repeatable).
                             Use "builder-unwrapped" to add missing parentheses
                             without any rewrite that reshapes the expression.
                             Codes: builder-unwrapped, builder-incompatible,
                             negated-comparison, prefer-english-operator,
                             prefer-clike-operator, prefer-in-list.
  --prettify               Reformat expressions in YAML files for readability.
                             Breaks long expressions across multiple lines using
                             >- (folded block scalar) syntax.
  --convert-block-scalars    Convert existing | and |- block scalars to >-.
                             Use with --prettify. Short expressions become inline.
  --check                    Dry-run for --fix or --prettify. Exits non-zero if
                             any changes would be made, without modifying files.
  --max-width <n>            Max expression width for --prettify (default: 100).
                             Accounts for ~20 chars of YAML indentation.
  --max-in-list-items <n>    Warn when a literal in-list has this many items
                             or more (default: 10). Suggests using a named list.
  --version, -v              Show version number
  --help, -h                 Show this help

Config File:
  Place a .cf-expr-lint.json in your project root (auto-detected), or
  specify with --config. Example:

  {
    "expressionKeys": {
      "rewrite_expression": { "type": "rewrite_url", "phaseHint": "http_request_transform" },
      "source_url_expression": { "type": "filter", "phaseHint": "http_request_dynamic_redirect" },
      "redirect_target": { "type": "redirect_target" }
    },
    "phaseMappings": {
      "waf_rules": "http_request_firewall_custom",
      "transform_rules": "http_request_late_transform",
      "url_rewrite_rules": "http_request_transform"
    }
  }

  Custom mappings are merged with built-in defaults. The built-in
  expression key is "expression" (the Terraform provider attribute).
  Built-in phase mappings include Cloudflare phase names and common
  shorthands like "cache_rules" and "single_redirects".

Inline Directives:
  Suppress diagnostics in YAML files with comment directives. Optional
  comma- or space-separated diagnostic codes narrow the scope; omitting
  codes suppresses all codes within the directive's range.

  # cf-expr-lint-disable-file [code,...]
      Suppresses diagnostics for the entire file.

  # cf-expr-lint-disable [code,...]
  ...
  # cf-expr-lint-enable [code,...]
      Suppresses diagnostics on lines between the two directives.

  # cf-expr-lint-disable-next-line [code,...]
  expression: >-
    ...
      Suppresses diagnostics on the following expression. When the next
      line is an expression key, the suppression covers the entire value
      (including all lines of a >- block scalar).

  expression: 'http.host eq "x"'  # cf-expr-lint-disable-line
      Suppresses diagnostics on the same line as the directive.

Examples:
  # Scan with defaults (detects "expression" keys, infers phase from context)
  cf-expr-lint config/**/*.yaml

  # Scan with custom expression keys and phase mappings
  cf-expr-lint \\
    --expr-key rewrite_expression:rewrite_url:http_request_transform \\
    --expr-key source_url_expression:filter:http_request_dynamic_redirect \\
    --phase-map waf_rules:http_request_firewall_custom \\
    config/**/*.yaml

  # Scan with config file
  cf-expr-lint --config .cf-expr-lint.json config/**/*.yaml

  # Validate a single expression
  cf-expr-lint -e '(http.host eq "test.com")'
  cf-expr-lint -e 'regex_replace(http.request.uri.path, "^/old/", "/")' -t rewrite_url
  cf-expr-lint -e 'http.response.code eq 200' -p http_request_firewall_custom
`);
}

function filterDiagnostics(diagnostics: Diagnostic[], ignoreCodes: string[]): Diagnostic[] {
  if (ignoreCodes.length === 0) return diagnostics;
  const ignoreSet = new Set(ignoreCodes);
  return diagnostics.filter(d => !ignoreSet.has(d.code));
}

function applyDirectiveFilter<T extends { expressions: { result: { diagnostics: Diagnostic[] } }[] }>(
  scanResult: T,
  ranges: SuppressionRange[],
  keyLines: { keyLine: number }[],
): T {
  if (ranges.length === 0) return scanResult;
  const filteredExpressions = scanResult.expressions.map((expr, idx) => {
    const keyLine = keyLines[idx]?.keyLine;
    if (keyLine === undefined) return expr;
    const diagnostics = expr.result.diagnostics.filter(
      d => !isLineSuppressed(ranges, keyLine, d.code),
    );
    return { ...expr, result: { ...expr.result, diagnostics } };
  });
  return { ...scanResult, expressions: filteredExpressions };
}

function formatDiagnostic(d: Diagnostic): string {
  const prefix = d.severity === 'error' ? '✗' : d.severity === 'warning' ? '⚠' : 'ℹ';
  const pos = d.position !== undefined ? ` (pos ${d.position})` : '';
  return `  ${prefix} [${d.code}]${pos}: ${d.message}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // A typo here would silently fix nothing, which in --check mode reads as a pass.
  if (opts.fixOnly.length > 0) {
    const unknown = opts.fixOnly.filter(c => !(FIXABLE_CODES as readonly string[]).includes(c));
    if (unknown.length > 0) {
      console.error(`Unknown --fix-only code(s): ${unknown.join(', ')}`);
      console.error(`Valid codes: ${FIXABLE_CODES.join(', ')}`);
      process.exit(1);
    }
    if (!opts.fix) {
      console.error('--fix-only requires --fix');
      process.exit(1);
    }
  }


  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let hasErrors = false;
  let hasWarnings = false;
  const jsonResults: unknown[] = [];

  // ── Single expression mode ────────────────────────────────────────
  if (opts.expression || opts.stdin) {
    let expr: string;
    if (opts.stdin) {
      expr = readFileSync(0, 'utf-8').trim();
    } else {
      expr = opts.expression!;
    }

    if (opts.fix) {
      const result = fixExpression(expr, { operatorStyle: opts.operatorStyle, expressionType: opts.type, fixOnly: opts.fixOnly });
      console.log(result.expression);
      if (result.fixes.length > 0) {
        console.error(`Fixes: ${result.fixes.join(', ')}`);
      }
      process.exit(0);
    }

    if (opts.prettify) {
      console.log(formatExpression(expr, { maxWidth: opts.maxWidth }));
      process.exit(0);
    }

    const ctx: ValidationContext = {
      expressionType: opts.type,
      phase: opts.phase,
      operatorStyle: opts.operatorStyle,
      maxInListItems: opts.maxInListItems,
    };

    const result = validate(expr, ctx);
    const diags = filterDiagnostics(result.diagnostics, opts.ignoreCodes);

    if (opts.format === 'json') {
      console.log(JSON.stringify({ ...result, diagnostics: diags }, null, 2));
    } else {
      const filteredDiags = opts.quiet
        ? diags.filter(d => d.severity === 'error')
        : diags;

      if (filteredDiags.length === 0) {
        console.log(`✓ Expression is valid`);
      } else {
        console.log(`Expression: ${expr.substring(0, 100)}${expr.length > 100 ? '...' : ''}`);
        for (const d of filteredDiags) {
          console.log(formatDiagnostic(d));
        }
      }

      if (diags.some(d => d.severity === 'error')) hasErrors = true;
      if (diags.some(d => d.severity === 'warning')) hasWarnings = true;
    }

    process.exit(hasErrors ? 1 : hasWarnings ? opts.warnExitCode : 0);
  }

  // ── File scanning mode ────────────────────────────────────────────
  if (opts.files.length === 0) {
    printHelp();
    process.exit(1);
  }

  const scannerOpts = buildScannerOptions(opts);

  // Expand globs
  const expandedFiles: string[] = [];
  for (const pattern of opts.files) {
    const matches = await glob(pattern);
    expandedFiles.push(...matches);
  }

  if (expandedFiles.length === 0) {
    console.error('No files matched the given patterns');
    process.exit(1);
  }

  // Carried across when --fix and --prettify are combined
  let fixedCount = 0;
  let fixedFiles = 0;

  // ── Fix mode ────────────────────────────────────────────────────
  if (opts.fix) {
    let totalFixed = 0;
    let totalFiles = 0;

    for (const file of expandedFiles) {
      const absPath = resolve(file);
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch (err) {
        console.error(`Error reading ${file}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      const scanResult = scanYaml(content, file, scannerOpts);
      if (scanResult.parseError || scanResult.expressions.length === 0) continue;

      // Build replacements map: canonical original → fixed expression
      const replacements = new Map<string, string>();
      for (const expr of scanResult.expressions) {
        const result = fixExpression(expr.expression, { operatorStyle: opts.operatorStyle, expressionType: expr.expressionType, fixOnly: opts.fixOnly });
        if (!result.changed) continue;
        // Canonicalize the original to match what rewriteExpressions uses for lookup
        const canonical = formatExpression(expr.expression, { maxWidth: Infinity });
        replacements.set(canonical, result.expression);
        totalFixed++;
        if (!opts.quiet) {
          for (const fix of result.fixes) {
            console.log(`  ${file}: ${fix}`);
          }
        }
      }

      if (replacements.size > 0) {
        if (!opts.check) {
          // Route through rewriteExpressions so --fix produces identical >- output as --prettify
          const result = rewriteExpressions(content, scanResult.expressions, {
            maxWidth: opts.maxWidth,
            convertBlockScalars: true,
            replacements,
          });
          writeFileSync(absPath, result.content, 'utf-8');
        }
        totalFiles++;
      }
    }

    // When --prettify is also set, fall through so formatting is applied too.
    // Fix only rewrites files that had a semantic fix, so files needing just
    // formatting would otherwise be left untouched.
    if (!opts.prettify) {
      if (opts.check) {
        if (totalFixed > 0) {
          console.log(`\n${totalFixed} expressions in ${totalFiles} files need fixing`);
          process.exit(1);
        }
        console.log('\nAll expressions are already fixed');
        process.exit(0);
      }

      console.log(`\nFixed ${totalFixed} expressions in ${totalFiles} files`);
      process.exit(0);
    }

    fixedCount = totalFixed;
    fixedFiles = totalFiles;
  }

  // ── Prettify mode ────────────────────────────────────────────────
  if (opts.prettify) {
    let totalFormatted = 0;
    let totalFiles = 0;

    for (const file of expandedFiles) {
      const absPath = resolve(file);
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch (err) {
        console.error(`Error reading ${file}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      const scanResult = scanYaml(content, file, scannerOpts);
      if (scanResult.parseError || scanResult.expressions.length === 0) continue;

      const result = rewriteExpressions(content, scanResult.expressions, {
        maxWidth: opts.maxWidth,
        convertBlockScalars: opts.convertBlockScalars,
      });

      if (result.count > 0) {
        if (!opts.check) {
          writeFileSync(absPath, result.content, 'utf-8');
        }
        totalFiles++;
        totalFormatted += result.count;
        if (!opts.check) console.log(`  ✓ ${file}`);
      }
    }

    if (opts.check) {
      if (totalFormatted > 0 || fixedCount > 0) {
        if (fixedCount > 0) console.log(`\n${fixedCount} expressions in ${fixedFiles} files need fixing`);
        if (totalFormatted > 0) console.log(`${totalFormatted} expressions in ${totalFiles} files need formatting`);
        process.exit(1);
      }
      console.log('\nAll expressions are already fixed and formatted');
      process.exit(0);
    }

    if (fixedCount > 0) console.log(`\nFixed ${fixedCount} expressions in ${fixedFiles} files`);
    console.log(`${fixedCount > 0 ? '' : '\n'}Formatted ${totalFormatted} expressions in ${totalFiles} files`);
    process.exit(0);
  }

  let totalExpressions = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  // Build the set of expression keys (defaults + user-configured) once.
  // Used to recognize expression-key lines for directive anchor mode.
  const expressionKeySet = new Set<string>([
    ...Object.keys(getDefaultExpressionKeys()),
    ...Object.keys(scannerOpts?.expressionKeys ?? {}),
  ]);

  for (const file of expandedFiles) {
    const absPath = resolve(file);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch (err) {
      console.error(`Error reading ${file}: ${err instanceof Error ? err.message : err}`);
      hasErrors = true;
      continue;
    }

    const scanResult = scanYaml(content, file, scannerOpts);

    if (scanResult.parseError) {
      console.error(`Error parsing ${file}: ${scanResult.parseError}`);
      hasErrors = true;
      continue;
    }

    const { ranges: directiveRanges, expressionKeyLines } = analyzeDirectives(
      content,
      expressionKeySet,
    );

    if (opts.format === 'json') {
      // Apply directive filtering before emitting JSON, too.
      const filteredScan = applyDirectiveFilter(scanResult, directiveRanges, expressionKeyLines);
      jsonResults.push(filteredScan);
      continue;
    }

    for (let exprIdx = 0; exprIdx < scanResult.expressions.length; exprIdx++) {
      const expr = scanResult.expressions[exprIdx];
      totalExpressions++;
      const keyLine = expressionKeyLines[exprIdx]?.keyLine;
      const directiveFiltered = keyLine !== undefined
        ? expr.result.diagnostics.filter(d => !isLineSuppressed(directiveRanges, keyLine, d.code))
        : expr.result.diagnostics;
      const diags = filterDiagnostics(directiveFiltered, opts.ignoreCodes);
      const displayDiags = opts.quiet
        ? diags.filter(d => d.severity === 'error')
        : diags;

      const errors = diags.filter(d => d.severity === 'error').length;
      const warnings = diags.filter(d => d.severity === 'warning').length;
      totalErrors += errors;
      totalWarnings += warnings;

      if (displayDiags.length > 0) {
        console.log(`\n${file} → ${expr.yamlPath}`);
        console.log(`  Expression: ${expr.expression.substring(0, 120)}${expr.expression.length > 120 ? '...' : ''}`);
        for (const d of displayDiags) {
          console.log(formatDiagnostic(d));
        }
      }

      if (errors > 0) hasErrors = true;
      if (warnings > 0) hasWarnings = true;
    }
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(jsonResults, null, 2));
  } else {
    console.log(`\n─────────────────────────────────────────────`);
    console.log(`Scanned ${expandedFiles.length} files, ${totalExpressions} expressions`);
    console.log(`  ${totalErrors} errors, ${totalWarnings} warnings`);
    if (!hasErrors) {
      console.log(`  ✓ All expressions valid`);
    }
  }

  process.exit(hasErrors ? 1 : hasWarnings ? opts.warnExitCode : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
