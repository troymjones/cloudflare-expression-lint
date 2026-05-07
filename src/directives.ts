/**
 * Inline disable directives for the CF expression linter.
 *
 * Four forms (all standard linter conventions):
 *
 *   # cf-expr-lint-disable-file [code1,code2,...]
 *     Suppresses diagnostics for the entire file. Place anywhere; convention
 *     is the top of the file.
 *
 *   # cf-expr-lint-disable [code1,...]
 *   ...
 *   # cf-expr-lint-enable [code1,...]
 *     Suppresses diagnostics on lines between the two directives.
 *     An unterminated disable runs to end-of-file.
 *
 *   # cf-expr-lint-disable-next-line [code1,...]
 *     Suppresses diagnostics on the following non-blank, non-comment line.
 *     ANCHOR MODE: if that line is a known expression key (e.g. `expression:`),
 *     the suppression covers the entire value range — including all lines
 *     of a `>-` block scalar.
 *
 *   # cf-expr-lint-disable-line [code1,...]
 *     Suppresses diagnostics on the same line as the directive.
 *     Mainly useful as a trailing comment on inline expression values.
 *
 * Codes are optional. When omitted, the directive suppresses ALL diagnostic
 * codes within its scope. Multiple codes may be separated by commas or
 * whitespace. Diagnostics from the validator do not carry per-line offsets
 * within block scalars, so suppression is anchored at the YAML key line of
 * each expression.
 */

// Directives may appear on a comment-only line (`# cf-expr-lint-disable...`)
// or as a trailing comment on a YAML structural line
// (`expression: '...'  # cf-expr-lint-disable-line`). The `(?:^|\s)` requires
// the `#` to start a comment (not appear inside a quoted string). Lines
// inside block-scalar content are excluded by the caller.
const DIRECTIVE_RE =
  /(?:^|\s)#\s*cf-expr-lint-(disable-file|disable-next-line|disable-line|disable|enable)\b([^#\n]*)/;

const BLOCK_SCALAR_INDICATORS = new Set(['|', '>-', '>', '|+', '|-', '>+']);

export type DirectiveKind =
  | 'disable-file'
  | 'disable'
  | 'enable'
  | 'disable-next-line'
  | 'disable-line';

export interface Directive {
  kind: DirectiveKind;
  /** 1-based line number where the directive comment appears. */
  line: number;
  /** Set of diagnostic codes the directive applies to, or null = all codes. */
  codes: Set<string> | null;
}

export interface SuppressionRange {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** null = matches all codes. */
  codes: Set<string> | null;
}

interface LineInfo {
  /** 0-based index. */
  index: number;
  text: string;
  isComment: boolean;
  isBlockScalarContent: boolean;
  isBlank: boolean;
  /** Set when this line opens a value under a configured expression key. */
  expressionKey?: { name: string; indent: number; rangeEnd: number };
}

function countIndent(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function classifyLines(content: string, expressionKeys: ReadonlySet<string>): LineInfo[] {
  const rawLines = content.split('\n').map(l => l.replace(/\r$/, ''));
  const result: LineInfo[] = rawLines.map((text, index) => ({
    index,
    text,
    isComment: false,
    isBlockScalarContent: false,
    isBlank: text.trim() === '',
  }));

  // First pass: detect block-scalar regions and comment lines, flag expression keys.
  let blockScalarIndent: number | null = null;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (blockScalarIndent !== null) {
      const indent = countIndent(line);
      if (line.trim() === '' || indent > blockScalarIndent) {
        result[i].isBlockScalarContent = true;
        continue;
      }
      blockScalarIndent = null;
    }
    if (/^\s*#/.test(line)) {
      result[i].isComment = true;
      continue;
    }
    const keyMatch = line.match(/^(\s*(?:-\s+)?)([\w_]+):\s*(.*)$/);
    if (keyMatch) {
      const [, fullIndent, key, rest] = keyMatch;
      const indent = fullIndent.length;
      const trailing = rest.replace(/\s+#.*$/, '').trim();
      if (BLOCK_SCALAR_INDICATORS.has(trailing)) {
        blockScalarIndent = indent;
      }
      if (expressionKeys.has(key)) {
        result[i].expressionKey = { name: key, indent, rangeEnd: i };
      }
    }
  }

  // Second pass: compute the end-line of each expression key's value.
  for (let i = 0; i < result.length; i++) {
    const ek = result[i].expressionKey;
    if (!ek) continue;
    let j = i + 1;
    while (j < result.length) {
      const text = result[j].text;
      const indent = countIndent(text);
      if (text.trim() === '' || indent > ek.indent) {
        j++;
      } else {
        break;
      }
    }
    while (j > i + 1 && result[j - 1].text.trim() === '') j--;
    ek.rangeEnd = j - 1;
  }

  return result;
}

function parseCodes(raw: string): Set<string> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const codes = trimmed
    .split(/[\s,]+/)
    .map(c => c.trim())
    .filter(c => c.length > 0);
  return codes.length === 0 ? null : new Set(codes);
}

function parseDirectives(lines: LineInfo[]): Directive[] {
  const out: Directive[] = [];
  for (const line of lines) {
    // Block-scalar content is literal text, not real comments — never parse
    // directives from those lines, even if they happen to contain the prefix.
    if (line.isBlockScalarContent) continue;
    const m = line.text.match(DIRECTIVE_RE);
    if (!m) continue;
    out.push({
      kind: m[1] as DirectiveKind,
      line: line.index + 1,
      codes: parseCodes(m[2] ?? ''),
    });
  }
  return out;
}

function buildRanges(lines: LineInfo[], directives: Directive[]): SuppressionRange[] {
  const ranges: SuppressionRange[] = [];
  const totalLines = lines.length;
  let active: { startLine: number; codes: Set<string> | null } | null = null;

  for (const d of directives) {
    switch (d.kind) {
      case 'disable-file':
        ranges.push({ startLine: 1, endLine: totalLines, codes: d.codes });
        break;

      case 'disable':
        if (!active) active = { startLine: d.line, codes: d.codes };
        break;

      case 'enable':
        if (active) {
          ranges.push({ startLine: active.startLine, endLine: d.line, codes: active.codes });
          active = null;
        }
        break;

      case 'disable-next-line': {
        // Find next non-blank, non-comment line.
        let j = d.line; // d.line is 1-based; lines[d.line] is the next line (0-based index d.line).
        while (j < lines.length && (lines[j].isBlank || lines[j].isComment)) j++;
        if (j >= lines.length) break;
        const target = lines[j];
        if (target.expressionKey) {
          ranges.push({
            startLine: target.index + 1,
            endLine: target.expressionKey.rangeEnd + 1,
            codes: d.codes,
          });
        } else {
          ranges.push({
            startLine: target.index + 1,
            endLine: target.index + 1,
            codes: d.codes,
          });
        }
        break;
      }

      case 'disable-line':
        ranges.push({ startLine: d.line, endLine: d.line, codes: d.codes });
        break;
    }
  }

  if (active) {
    ranges.push({ startLine: active.startLine, endLine: totalLines, codes: active.codes });
  }

  return ranges;
}

export interface DirectiveAnalysis {
  ranges: SuppressionRange[];
  /** Source-order list of expression-key line ranges, used to map scan-result
   *  expressions back to YAML positions. */
  expressionKeyLines: { keyLine: number; rangeEnd: number; name: string }[];
}

export function analyzeDirectives(
  content: string,
  expressionKeys: ReadonlySet<string>,
): DirectiveAnalysis {
  const lines = classifyLines(content, expressionKeys);
  const directives = parseDirectives(lines);
  const ranges = buildRanges(lines, directives);
  const expressionKeyLines = lines
    .filter(l => l.expressionKey)
    .map(l => ({
      keyLine: l.index + 1,
      rangeEnd: l.expressionKey!.rangeEnd + 1,
      name: l.expressionKey!.name,
    }));
  return { ranges, expressionKeyLines };
}

export function isLineSuppressed(
  ranges: SuppressionRange[],
  line: number,
  code: string,
): boolean {
  for (const r of ranges) {
    if (line < r.startLine || line > r.endLine) continue;
    if (r.codes === null || r.codes.has(code)) return true;
  }
  return false;
}
