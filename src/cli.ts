#!/usr/bin/env node

/**
 * CLI for cloudflare-expression-lint.
 *
 * Usage:
 *   cf-expr-lint [options] <files...>
 *   cf-expr-lint --expression "http.host eq \"test.com\""
 *   cf-expr-lint config/**\/*.yaml
 *   echo 'http.host eq "test"' | cf-expr-lint --stdin
 *
 * Options:
 *   --expression, -e   Validate a single expression string
 *   --stdin             Read expression from stdin
 *   --type, -t          Expression type: filter (default), rewrite_url, rewrite_header, redirect_target
 *   --phase, -p         Cloudflare phase (e.g., http_request_firewall_custom)
 *   --format, -f        Output format: text (default), json
 *   --quiet, -q         Only output errors (suppress warnings)
 *   --help, -h          Show this help message
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { glob } from 'glob';
import { validate } from './validator.js';
import { scanYaml } from './yaml-scanner.js';
import type { ValidationContext, ExpressionType, Diagnostic } from './types.js';

interface CLIOptions {
  files: string[];
  expression?: string;
  stdin: boolean;
  type: ExpressionType;
  phase?: string;
  format: 'text' | 'json';
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CLIOptions {
  const opts: CLIOptions = {
    files: [],
    stdin: false,
    type: 'filter',
    format: 'text',
    quiet: false,
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
      case '--format':
      case '-f':
        opts.format = argv[++i] as 'text' | 'json';
        break;
      case '--quiet':
      case '-q':
        opts.quiet = true;
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

function printHelp(): void {
  console.log(`
cloudflare-expression-lint - Validate Cloudflare Rules Language expressions

Usage:
  cf-expr-lint [options] <files...>
  cf-expr-lint -e "http.host eq \\"test.com\\""
  echo 'http.host eq "test"' | cf-expr-lint --stdin

Options:
  --expression, -e <expr>  Validate a single expression string
  --stdin                  Read expression from stdin
  --type, -t <type>        Expression type: filter (default), rewrite_url,
                           rewrite_header, redirect_target
  --phase, -p <phase>      Cloudflare phase for field validation
  --format, -f <fmt>       Output format: text (default), json
  --quiet, -q              Only show errors (suppress warnings/info)
  --help, -h               Show this help

Files:
  Accepts YAML files (.yaml, .yml). Glob patterns are expanded.
  Expressions are auto-detected from YAML keys like "expression",
  "rewrite_expression", "source_url_expression", etc.

Examples:
  cf-expr-lint config/**/*.yaml
  cf-expr-lint -e '(http.host eq "test.com")'
  cf-expr-lint -e 'regex_replace(http.request.uri.path, "^/old/", "/")' -t rewrite_url
  cf-expr-lint -p http_request_firewall_custom config/waf/*.yaml
`);
}

function formatDiagnostic(d: Diagnostic, file?: string, yamlPath?: string): string {
  const location = [file, yamlPath].filter(Boolean).join(' → ');
  const prefix = d.severity === 'error' ? '✗' : d.severity === 'warning' ? '⚠' : 'ℹ';
  const pos = d.position !== undefined ? ` (pos ${d.position})` : '';
  return `  ${prefix} [${d.code}]${pos}: ${d.message}${location ? `\n    in ${location}` : ''}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let hasErrors = false;
  const jsonResults: unknown[] = [];

  // ── Single expression mode ────────────────────────────────────────
  if (opts.expression || opts.stdin) {
    let expr: string;
    if (opts.stdin) {
      expr = readFileSync(0, 'utf-8').trim();
    } else {
      expr = opts.expression!;
    }

    const ctx: ValidationContext = {
      expressionType: opts.type,
      phase: opts.phase,
    };

    const result = validate(expr, ctx);

    if (opts.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const filteredDiags = opts.quiet
        ? result.diagnostics.filter(d => d.severity === 'error')
        : result.diagnostics;

      if (filteredDiags.length === 0) {
        console.log(`✓ Expression is valid`);
      } else {
        console.log(`Expression: ${expr.substring(0, 100)}${expr.length > 100 ? '...' : ''}`);
        for (const d of filteredDiags) {
          console.log(formatDiagnostic(d));
        }
      }

      if (!result.valid) hasErrors = true;
    }

    process.exit(hasErrors ? 1 : 0);
  }

  // ── File scanning mode ────────────────────────────────────────────
  if (opts.files.length === 0) {
    printHelp();
    process.exit(1);
  }

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

  let totalExpressions = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

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

    const scanResult = scanYaml(content, file);

    if (scanResult.parseError) {
      console.error(`Error parsing ${file}: ${scanResult.parseError}`);
      hasErrors = true;
      continue;
    }

    if (opts.format === 'json') {
      jsonResults.push(scanResult);
      continue;
    }

    for (const expr of scanResult.expressions) {
      totalExpressions++;
      const filteredDiags = opts.quiet
        ? expr.result.diagnostics.filter(d => d.severity === 'error')
        : expr.result.diagnostics;

      const errors = expr.result.diagnostics.filter(d => d.severity === 'error').length;
      const warnings = expr.result.diagnostics.filter(d => d.severity === 'warning').length;
      totalErrors += errors;
      totalWarnings += warnings;

      if (filteredDiags.length > 0) {
        console.log(`\n${file} → ${expr.yamlPath}`);
        console.log(`  Expression: ${expr.expression.substring(0, 120)}${expr.expression.length > 120 ? '...' : ''}`);
        for (const d of filteredDiags) {
          console.log(formatDiagnostic(d));
        }
      }

      if (!expr.result.valid) hasErrors = true;
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

  process.exit(hasErrors ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
