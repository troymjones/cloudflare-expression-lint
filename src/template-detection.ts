/**
 * Template placeholder detection.
 *
 * Detects template variables in expression strings that will be
 * substituted before deployment (e.g., by Terraform templatefile()).
 */

/**
 * Detect if an expression contains template placeholders.
 *
 * Common patterns:
 *   - UPPER_CASE_IDENTIFIERS inside expressions (not quoted)
 *   - ${variable} Terraform interpolation
 *   - __NAME__ double-underscore convention
 */
export function containsTemplatePlaceholders(expression: string): boolean {
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (inQuote) continue;

    // Check for ${...} interpolation
    if (ch === '$' && expression[i + 1] === '{') return true;

    // Check for UPPER_CASE_IDENTIFIER (at least 4 chars with underscore)
    if (/[A-Z]/.test(ch)) {
      let j = i;
      while (j < expression.length && /[A-Z0-9_]/.test(expression[j])) j++;
      const word = expression.slice(i, j);
      if (word.length >= 4 && word.includes('_') && /^[A-Z][A-Z0-9_]+$/.test(word)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect if an expression contains legacy-format placeholders (UPPER_CASE_VAR
 * without __double_underscore__ delimiters). Returns false if all placeholders
 * use the preferred __NAME__ format.
 */
export function containsLegacyPlaceholders(expression: string): boolean {
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (inQuote) continue;

    // Skip __NAME__ patterns (preferred format)
    if (ch === '_' && expression[i + 1] === '_') {
      let j = i + 2;
      while (j < expression.length && /[A-Z0-9_]/.test(expression[j])) j++;
      const word = expression.slice(i, j);
      if (word.length >= 6 && word.endsWith('__')) {
        i = j - 1;
        continue;
      }
    }

    // Check for bare UPPER_CASE_IDENTIFIER (legacy)
    if (/[A-Z]/.test(ch)) {
      if (i > 0 && expression[i - 1] === '.') continue;
      if (i > 0 && /[a-zA-Z]/.test(expression[i - 1])) continue;
      let j = i;
      while (j < expression.length && /[A-Z0-9_]/.test(expression[j])) j++;
      const word = expression.slice(i, j);
      if (word.length >= 4 && word.includes('_') && /^[A-Z][A-Z0-9_]+$/.test(word)) {
        return true;
      }
    }
  }
  return false;
}
