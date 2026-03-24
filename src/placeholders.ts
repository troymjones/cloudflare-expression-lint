/**
 * Placeholder pre-processing for template expressions.
 *
 * Cloudflare expressions in YAML may contain template placeholders
 * (e.g., ALLOWED_IPS from Terraform templatefile()) that can't be
 * parsed. We substitute them with valid synthetic values before
 * parsing and restore them after formatting/fixing.
 *
 * Supported placeholder patterns:
 *   - __NAME__ (preferred convention, e.g., __ALLOWED_IPS__)
 *   - UPPER_CASE_IDENTIFIER (legacy, e.g., ALLOWED_IPS)
 */

export interface SubstitutionResult {
  /** Expression with placeholders replaced by synthetic values */
  expression: string;
  /** Map from synthetic value (with quotes) to original placeholder text */
  map: Map<string, string>;
}

/**
 * Detect and substitute placeholders with valid synthetic string literals.
 * Returns the modified expression and a map for restoration.
 */
export function substitutePlaceholders(expression: string): SubstitutionResult {
  const map = new Map<string, string>();
  const placeholderToSynthetic = new Map<string, string>();
  let counter = 0;

  // Find all placeholder positions (outside quoted strings)
  const placeholders = findPlaceholders(expression);
  if (placeholders.length === 0) {
    return { expression, map };
  }

  // Build substituted expression from right to left to preserve offsets
  let result = expression;
  for (let i = placeholders.length - 1; i >= 0; i--) {
    const { start, end, name } = placeholders[i];

    let synthetic: string;
    if (placeholderToSynthetic.has(name)) {
      synthetic = placeholderToSynthetic.get(name)!;
    } else {
      // Pad the synthetic value so its total length (with quotes) matches
      // the original placeholder's length. This ensures the formatter
      // makes correct line-width decisions.
      const innerLen = Math.max(4, name.length - 2); // -2 for the added quotes
      const inner = `ph${counter}`.padEnd(innerLen, '_');
      synthetic = `"${inner}"`;
      placeholderToSynthetic.set(name, synthetic);
      map.set(synthetic, name);
      counter++;
    }

    result = result.substring(0, start) + synthetic + result.substring(end);
  }

  return { expression: result, map };
}

/**
 * Restore original placeholder text in a formatted/fixed expression.
 */
export function restorePlaceholders(expression: string, map: Map<string, string>): string {
  if (map.size === 0) return expression;

  let result = expression;
  for (const [synthetic, original] of map) {
    // Replace all occurrences — the synthetic value includes quotes
    while (result.includes(synthetic)) {
      result = result.replace(synthetic, original);
    }
  }
  return result;
}

/**
 * Check if an expression contains template placeholders.
 */
export function containsPlaceholders(expression: string): boolean {
  return findPlaceholders(expression).length > 0;
}

interface PlaceholderMatch {
  start: number;
  end: number;
  name: string;
}

/**
 * Find all placeholder occurrences outside quoted strings.
 */
function findPlaceholders(expression: string): PlaceholderMatch[] {
  const matches: PlaceholderMatch[] = [];
  let inQuote = false;
  let escaped = false;

  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (inQuote) continue;

    // Check for __NAME__ pattern (preferred)
    if (ch === '_' && expression[i + 1] === '_') {
      const match = matchDoubleUnderscore(expression, i);
      if (match) {
        matches.push(match);
        i = match.end - 1; // skip past the match
        continue;
      }
    }

    // Check for UPPER_CASE_IDENTIFIER pattern (legacy)
    if (/[A-Z]/.test(ch)) {
      const match = matchUpperCaseIdentifier(expression, i);
      if (match) {
        matches.push(match);
        i = match.end - 1;
        continue;
      }
    }
  }

  return matches;
}

/** Match __NAME__ pattern starting at position i */
function matchDoubleUnderscore(expr: string, i: number): PlaceholderMatch | null {
  if (expr[i] !== '_' || expr[i + 1] !== '_') return null;

  let j = i + 2;
  if (j >= expr.length || !/[A-Z]/.test(expr[j])) return null;

  while (j < expr.length && /[A-Z0-9_]/.test(expr[j])) j++;

  // Must end with __ (the last two chars of the match)
  const word = expr.slice(i, j);
  if (word.length < 6 || !word.endsWith('__')) return null;

  // Inner content between __ delimiters must not be empty
  const inner = word.slice(2, -2);
  if (inner.length === 0) return null;

  return { start: i, end: j, name: word };
}

/** Match UPPER_CASE_IDENTIFIER pattern (legacy) starting at position i */
function matchUpperCaseIdentifier(expr: string, i: number): PlaceholderMatch | null {
  let j = i;
  while (j < expr.length && /[A-Z0-9_]/.test(expr[j])) j++;

  const word = expr.slice(i, j);

  // Must be at least 4 chars, contain an underscore, and be all-caps
  if (word.length < 4) return null;
  if (!word.includes('_')) return null;
  if (!/^[A-Z][A-Z0-9_]+$/.test(word)) return null;

  // Must not be preceded by a dot (which would make it a field access like cf.BOT_MANAGEMENT)
  if (i > 0 && expr[i - 1] === '.') return null;

  // Must not be preceded by a letter (part of a longer identifier)
  if (i > 0 && /[a-zA-Z]/.test(expr[i - 1])) return null;

  return { start: i, end: j, name: word };
}
