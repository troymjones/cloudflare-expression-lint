/**
 * YAML expression rewriter.
 *
 * Finds expression values in YAML content and replaces them with
 * formatted multi-line versions using >- block scalar syntax.
 */

import { formatExpression, type FormatOptions } from './formatter.js';
import { findExpressionLocation } from './yaml-locator.js';
import { parse } from './parser.js';

// Re-export for backwards compatibility
export { findExpressionLocation } from './yaml-locator.js';

export interface RewriteOptions extends FormatOptions {
  /** Convert existing | and |- block scalars to >- */
  convertBlockScalars?: boolean;
  /** Map of canonical original expression → replacement expression.
   *  When provided, the replacement is formatted and written instead of the original. */
  replacements?: Map<string, string>;
  /** Leave every expression without a replacement byte-identical. Used by --fix
   *  so fixing one expression cannot reformat its neighbours. */
  onlyReplacements?: boolean;
}

export interface RewriteResult {
  /** The modified YAML content */
  content: string;
  /** Number of expressions that were reformatted */
  count: number;
}


/**
 * Rewrite expressions in YAML content for readability.
 * Returns the modified content and count of changes.
 */
export function rewriteExpressions(
  content: string,
  expressions: { expression: string }[],
  options?: RewriteOptions,
): RewriteResult {
  let modified = content;
  let count = 0;

  // Process expressions in reverse file order to avoid offset shifts
  // We find each expression's position fresh each time (after prior replacements)
  // by working backwards through the file
  const uniqueExprs = deduplicateExpressions(expressions);

  for (const expr of uniqueExprs) {
    // Compare against the canonical (parsed and re-printed) form of the original
    // to handle whitespace differences from >- block scalars
    const canonicalExpr = canonicalize(expr.expression);

    // If a replacement is provided, format the replacement instead of the original
    const exprToFormat = options?.replacements?.get(canonicalExpr) ?? expr.expression;
    const formatted = formatExpression(exprToFormat, options);
    const isMultiLine = formatted.includes('\n');

    // Skip if no change needed and not converting block scalars.
    // A value containing newlines still needs inspecting even when its
    // canonical form is a short single line: the YAML representation may be a
    // double-quoted scalar with \n escapes, which is never the canonical form.
    const hasReplacement = options?.replacements?.has(canonicalExpr) ?? false;
    if (options?.onlyReplacements && !hasReplacement) continue;
    const valueSpansLines = expr.expression.includes('\n');
    const mustInspect = hasReplacement || options?.convertBlockScalars || valueSpansLines;
    if (!mustInspect && formatted === canonicalExpr) continue;
    if (!mustInspect && !isMultiLine) continue;

    // Find all occurrences in the file (same expression may appear multiple times)
    let searchFrom = modified.length;
    while (true) {
      const location = findExpressionLocation(modified, expr.expression, searchFrom);
      if (!location) break;

      const { lineStart, lineEnd, indent, key, isBlockScalar } = location;
      searchFrom = lineStart; // next search ends before this match

      // Skip if already >- and the formatted output matches the existing block content.
      // Compare by reading the existing block lines and checking if they'd produce
      // the same >- block as the formatter would write.
      if (isBlockScalar === '>-' && isMultiLine) {
        const existingBlock = modified.substring(lineStart, lineEnd);
        const exprIndent = indent + '  ';
        const formattedLines = formatted.split('\n').map(l => exprIndent + l).join('\n');
        const wouldWrite = `${indent}${key} >-\n${formattedLines}\n`;
        if (existingBlock === wouldWrite) continue;
      }
      if (isBlockScalar === '>-' && !isMultiLine && formatted === canonicalExpr) continue;
      // Skip if inline, not multi-line, and content hasn't changed
      if (!isBlockScalar && !isMultiLine && formatted === canonicalExpr) continue;
      // Skip plain-multiline values that can't be parsed (template placeholders, etc.)
      // These have manual formatting we shouldn't collapse. Parseable expressions
      // should still be standardized to inline or >-.
      if (isBlockScalar === 'plain-multiline' && formatted === canonicalExpr) {
        let canParse = true;
        try { parse(canonicalExpr); } catch { canParse = false; }
        if (!canParse) continue;
      }
      // When converting block scalars, always rewrite |/|- to >-
      if (isBlockScalar && isBlockScalar !== '>-' && !isMultiLine && formatted === canonicalExpr) {
        // Short expression in |/|- — convert to inline
        const replacement = `${indent}${key} ${formatted}\n`;
        modified = modified.substring(0, lineStart) + replacement + modified.substring(lineEnd);
        count++;
        continue;
      }

      // Build the >- replacement with proper indentation
      const exprIndent = indent + '  ';
      const formattedLines = formatted.split('\n').map(l => exprIndent + l).join('\n');
      const replacement = `${indent}${key} >-\n${formattedLines}\n`;

      modified = modified.substring(0, lineStart) + replacement + modified.substring(lineEnd);
      count++;
    }
  }

  return { content: modified, count };
}

/** Canonicalize an expression by parsing and re-formatting as single line.
 *  This normalizes whitespace differences from >- block scalar joining. */
function canonicalize(expression: string): string {
  try {
    // formatExpression parses and re-prints, normalizing whitespace
    return formatExpression(expression, { maxWidth: Infinity });
  } catch {
    return expression.split('\n').map(l => l.trim()).filter(l => l !== '').join(' ').trim();
  }
}

/** Deduplicate expressions by their trimmed value */
function deduplicateExpressions(expressions: { expression: string }[]): { expression: string }[] {
  const seen = new Set<string>();
  return expressions.filter(e => {
    const key = canonicalize(e.expression);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

