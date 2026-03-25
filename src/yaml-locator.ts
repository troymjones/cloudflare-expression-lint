/**
 * YAML expression locator.
 *
 * Finds expression values in YAML content by line-scanning with regex.
 * Handles inline values, block scalars (|, >-, etc.), plain multi-line
 * values, next-line values, CRLF line endings, and escaped YAML quotes.
 */

/** Known YAML keys that contain Cloudflare expressions */
const DEFAULT_EXPRESSION_KEYS = new Set([
  'expression', 'source_url_expression', 'counting_expression',
  'rewrite_expression', 'condition',
]);

export interface ExpressionLocation {
  lineStart: number;
  lineEnd: number;
  indent: string;
  key: string;
  /** The block scalar type if the expression uses one, or null for inline */
  isBlockScalar?: string;
}

/**
 * Find the location of an expression value in YAML content,
 * searching backwards from `beforeOffset`.
 *
 * @param expressionKeys - Optional set of YAML keys to search for. Defaults to built-in expression keys.
 */
export function findExpressionLocation(
  content: string,
  expression: string,
  beforeOffset?: number,
  expressionKeys?: Set<string>,
): ExpressionLocation | null {
  const keys = expressionKeys ?? DEFAULT_EXPRESSION_KEYS;

  // Normalize the search expression: collapse whitespace so multi-line
  // scanner output matches against joined block scalar content
  const trimmed = expression.split('\n').map(l => l.trim()).filter(l => l !== '').join(' ').trim();

  // Strip \r from lines for regex matching (CRLF files), but keep offsets based on original content
  const rawLines = content.split('\n');
  const lines = rawLines.map(l => l.replace(/\r$/, ''));
  let offset = 0;
  const offsets: number[] = [];

  // Build line offset index using raw line lengths to preserve correct byte offsets
  for (const line of rawLines) {
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
    if (!keys.has(key)) continue;
    const indent = fullIndent;

    // ── Inline value ──────────────────────────────────────────────
    if (value && !isBlockScalarIndicator(value.trim())) {
      let unquoted = value.replace(/^['"]|['"]$/g, '').trim();
      // Unescape YAML double-quoted string escapes
      if (value.trim().startsWith('"')) {
        unquoted = unquoted.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      if (unquoted === trimmed || value.trim() === trimmed) {
        const lineEnd = offsets[i] + line.length + 1;
        return { lineStart: offsets[i], lineEnd, indent, key: `${key}:` };
      }

      // Plain multi-line value (wraps across lines without block scalar indicator)
      if (unquoted && !value.trim().startsWith('"') && !value.trim().startsWith("'")) {
        const result = tryPlainMultiline(lines, offsets, i, indent.length, value, trimmed, key, content.length);
        if (result) return result;
      }
    }

    // ── Block scalar (| or >-) ────────────────────────────────────
    if (isBlockScalarIndicator(value.trim())) {
      const result = tryBlockScalar(lines, offsets, i, indent.length, value.trim(), trimmed, key, content.length);
      if (result) return result;
    }

    // ── Value starts on the next line (key:\n  value...) ──────────
    if (!value || !value.trim()) {
      const result = tryNextLineValue(lines, offsets, i, indent.length, trimmed, key, content.length);
      if (result) return result;
    }
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

const BLOCK_SCALAR_INDICATORS = new Set(['|', '>-', '>', '|+', '|-', '>+']);

function isBlockScalarIndicator(value: string): boolean {
  return BLOCK_SCALAR_INDICATORS.has(value);
}

function countIndent(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/** Try to match a plain multi-line value (wraps across lines without block scalar indicator). */
function tryPlainMultiline(
  lines: string[], offsets: number[], i: number, keyIndent: number,
  value: string, trimmed: string, key: string, contentLength: number,
): ExpressionLocation | null {
  let j = i + 1;
  while (j < lines.length) {
    const nextLine = lines[j];
    if (nextLine.trim() === '' || countIndent(nextLine) > keyIndent) {
      j++;
    } else {
      break;
    }
  }
  if (j > i + 1) {
    const allLines = [value, ...lines.slice(i + 1, j)].map(l => l.trim()).filter(l => l !== '').join(' ').trim();
    if (allLines === trimmed) {
      const blockEnd = j < lines.length ? offsets[j] : contentLength;
      return { lineStart: offsets[i], lineEnd: blockEnd, indent: lines[i].match(/^(\s*(?:-\s+)?)/)?.[0] ?? '', key: `${key}:`, isBlockScalar: 'plain-multiline' };
    }
  }
  return null;
}

/** Try to match a block scalar (|, >-, >, etc.) value. */
function tryBlockScalar(
  lines: string[], offsets: number[], i: number, indentLen: number,
  scalarType: string, trimmed: string, key: string, contentLength: number,
): ExpressionLocation | null {
  const blockIndent = indentLen + 2;
  let j = i + 1;
  while (j < lines.length) {
    const nextLine = lines[j];
    if (nextLine.trim() === '' || countIndent(nextLine) >= blockIndent) {
      j++;
    } else {
      break;
    }
  }
  // Trim trailing blank lines — they're YAML structure, not block content
  while (j > i + 1 && lines[j - 1].trim() === '') j--;
  const blockContent = lines.slice(i + 1, j).map(l => l.trim()).filter(l => l !== '').join(' ').trim();
  if (blockContent === trimmed) {
    const blockEnd = j < lines.length ? offsets[j] : contentLength;
    const indent = lines[i].match(/^(\s*(?:-\s+)?)/)?.[0] ?? '';
    return { lineStart: offsets[i], lineEnd: blockEnd, indent, key: `${key}:`, isBlockScalar: scalarType };
  }
  return null;
}

/** Try to match a value that starts on the line after the key (key:\n  value...). */
function tryNextLineValue(
  lines: string[], offsets: number[], i: number, keyIndent: number,
  trimmed: string, key: string, contentLength: number,
): ExpressionLocation | null {
  let j = i + 1;
  while (j < lines.length) {
    const nextLine = lines[j];
    if (nextLine.trim() === '' || countIndent(nextLine) > keyIndent) {
      j++;
    } else {
      break;
    }
  }
  while (j > i + 1 && lines[j - 1].trim() === '') j--;
  if (j > i + 1) {
    const allLines = lines.slice(i + 1, j).map(l => l.trim()).filter(l => l !== '').join(' ').trim();
    if (allLines === trimmed) {
      const blockEnd = j < lines.length ? offsets[j] : contentLength;
      const indent = lines[i].match(/^(\s*(?:-\s+)?)/)?.[0] ?? '';
      return { lineStart: offsets[i], lineEnd: blockEnd, indent, key: `${key}:`, isBlockScalar: 'plain-multiline' };
    }
  }
  return null;
}
