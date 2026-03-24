/**
 * YAML expression rewriter.
 *
 * Finds expression values in YAML content and replaces them with
 * formatted multi-line versions using >- block scalar syntax.
 */

import { formatExpression, type FormatOptions } from './formatter.js';

export interface RewriteOptions extends FormatOptions {
  /** Convert existing | and |- block scalars to >- */
  convertBlockScalars?: boolean;
}

export interface RewriteResult {
  /** The modified YAML content */
  content: string;
  /** Number of expressions that were reformatted */
  count: number;
}

/** Known YAML keys that contain Cloudflare expressions */
const EXPRESSION_KEYS = new Set([
  'expression', 'source_url_expression', 'counting_expression',
  'rewrite_expression', 'condition',
]);

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
    const formatted = formatExpression(expr.expression, options);
    const isMultiLine = formatted.includes('\n');

    // Skip if no change needed and not converting block scalars
    if (formatted === expr.expression.trim() && !options?.convertBlockScalars) continue;
    if (!isMultiLine && !options?.convertBlockScalars) continue;

    // Find all occurrences in the file (same expression may appear multiple times)
    let searchFrom = modified.length;
    while (true) {
      const location = findExpressionLocation(modified, expr.expression, searchFrom);
      if (!location) break;

      const { lineStart, lineEnd, indent, key, isBlockScalar } = location;
      searchFrom = lineStart; // next search ends before this match

      // Skip if already >- and content hasn't changed
      if (isBlockScalar === '>-' && formatted === expr.expression.trim() && !isMultiLine) continue;
      // Skip if inline, not multi-line, and content hasn't changed
      if (!isBlockScalar && !isMultiLine && formatted === expr.expression.trim()) continue;
      // When converting block scalars, always rewrite |/|- to >-
      if (isBlockScalar && isBlockScalar !== '>-' && !isMultiLine && formatted === expr.expression.trim()) {
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

/** Deduplicate expressions by their trimmed value */
function deduplicateExpressions(expressions: { expression: string }[]): { expression: string }[] {
  const seen = new Set<string>();
  return expressions.filter(e => {
    const key = e.expression.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Find the location of an expression value in YAML content,
 * searching backwards from `beforeOffset`.
 */
export function findExpressionLocation(
  content: string, expression: string, beforeOffset?: number,
): {
  lineStart: number; lineEnd: number; indent: string; key: string;
  /** The block scalar type if the expression uses one, or null for inline */
  isBlockScalar?: string;
} | null {
  const trimmed = expression.trim();
  const lines = content.split('\n');
  let offset = 0;
  const offsets: number[] = [];

  // Build line offset index
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  // Search backwards from beforeOffset (or end of file)
  const maxOffset = beforeOffset ?? content.length;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (offsets[i] >= maxOffset) continue;

    const line = lines[i];
    const keyMatch = line.match(/^(\s*(?:-\s+)?)([\w_]+):\s*(.*)$/);
    if (!keyMatch) continue;

    const [, fullIndent, key, value] = keyMatch;
    if (!EXPRESSION_KEYS.has(key)) continue;
    // Use the whitespace portion for indentation (without list marker)
    const indent = fullIndent;

    // Inline value
    if (value && !['|', '>-', '>', '|+', '|-', '>+'].includes(value.trim())) {
      const unquoted = value.replace(/^['"]|['"]$/g, '').trim();
      if (unquoted === trimmed || value.trim() === trimmed) {
        const lineEnd = offsets[i] + line.length + 1;
        return { lineStart: offsets[i], lineEnd, indent, key: `${key}:` };
      }
    }

    // Block scalar (| or >-)
    if (['|', '>-', '>', '|+', '|-', '>+'].includes(value.trim())) {
      const blockIndent = indent.length + 2;
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (nextLine.trim() === '' || countIndent(nextLine) >= blockIndent) {
          j++;
        } else {
          break;
        }
      }
      const blockContent = lines.slice(i + 1, j).map(l => l.trim()).join(' ').trim();
      if (blockContent === trimmed) {
        const blockEnd = j < lines.length ? offsets[j] : content.length;
        return { lineStart: offsets[i], lineEnd: blockEnd, indent, key: `${key}:`, isBlockScalar: value.trim() };
      }
    }
  }

  return null;
}

function countIndent(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}
