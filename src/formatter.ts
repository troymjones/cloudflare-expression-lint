/**
 * Expression formatter/prettifier.
 *
 * Reformats Cloudflare expressions across multiple lines for readability,
 * breaking on logical operators and indenting nested groups.
 */

import { parse } from './parser.js';
import { substitutePlaceholders, restorePlaceholders } from './placeholders.js';
import type { ASTNode } from './types.js';

export interface FormatOptions {
  /** Maximum expression width before breaking. Default: 100 */
  maxWidth?: number;
  /** Indentation string. Default: '  ' (2 spaces) */
  indent?: string;
}

const DEFAULT_OPTIONS: Required<FormatOptions> = {
  maxWidth: 100,
  indent: '  ',
};

/**
 * Format a Cloudflare expression for readability.
 * Returns the formatted expression string (without YAML scalar prefix).
 */
export function formatExpression(expression: string, options?: FormatOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const trimmed = expression.trim();

  // Substitute placeholders so expressions with template vars can be parsed
  const { expression: substituted, map } = substitutePlaceholders(trimmed);

  // Try to parse — if it fails, return the expression as-is
  let ast: ASTNode;
  try {
    ast = parse(substituted);
  } catch {
    return trimmed;
  }

  const oneLine = printNode(ast);

  // If it fits on one line, return as-is
  if (oneLine.length <= opts.maxWidth) {
    return restorePlaceholders(oneLine, map);
  }

  // Format with line breaks
  return restorePlaceholders(printNodeMultiline(ast, 0, opts), map);
}

// ── Single-line printer ──────────────────────────────────────────────

/** Print an AST node as a single-line string (canonical form). */
function printNode(node: ASTNode): string {
  switch (node.kind) {
    case 'BooleanLiteral':
      return String(node.value);

    case 'StringLiteral':
      if (node.raw) return `r"${node.value}"`;
      return `"${escapeString(node.value)}"`;

    case 'IntegerLiteral':
      return String(node.value);

    case 'FloatLiteral':
      return String(node.value);

    case 'IPLiteral':
      return node.cidr !== undefined ? `${node.value}/${node.cidr}` : node.value;

    case 'FieldAccess': {
      let s = node.field;
      if (node.mapKey !== undefined) s += `["${escapeString(node.mapKey)}"]`;
      if (node.arrayIndex !== undefined) s += `[${node.arrayIndex}]`;
      return s;
    }

    case 'NamedList':
      return node.name.startsWith('$') ? node.name : `$${node.name}`;

    case 'FunctionCall': {
      const args = node.args.map(a => printNode(a)).join(', ');
      return `${node.name}(${args})`;
    }

    case 'Comparison':
      return `${printNode(node.left)} ${node.operator} ${printNode(node.right)}`;

    case 'Logical':
      return `${printNode(node.left)} ${node.operator} ${printNode(node.right)}`;

    case 'Not':
      return `not ${printNode(node.operand)}`;

    case 'InExpression': {
      const field = printNode(node.field);
      const neg = node.negated ? 'not ' : '';
      // Named list: ip.src in $list (no braces)
      if (node.values.length === 1 && node.values[0].kind === 'NamedList') {
        return `${neg}${field} in ${printNode(node.values[0])}`;
      }
      // Value list: ip.src in {1.2.3.4 5.6.7.8}
      const values = node.values.map(v => printNode(v)).join(' ');
      return `${neg}${field} in {${values}}`;
    }

    case 'Group':
      return `(${printNode(node.expression)})`;

    case 'ArrayUnpack':
      return `${printNode(node.field)}[*]`;
  }
}

// ── Multi-line printer ───────────────────────────────────────────────

/** Print an AST node with line breaks for readability. */
function printNodeMultiline(node: ASTNode, depth: number, opts: Required<FormatOptions>): string {
  const ind = opts.indent.repeat(depth);
  const indInner = opts.indent.repeat(depth + 1);

  // For non-logical, non-group, non-not nodes, just use the single-line form
  if (node.kind !== 'Logical' && node.kind !== 'Group' && node.kind !== 'Not') {
    return printNode(node);
  }

  // Not — try to break the operand
  if (node.kind === 'Not') {
    const oneLine = printNode(node);
    if (oneLine.length + ind.length <= opts.maxWidth) {
      return oneLine;
    }
    const operandFormatted = printNodeMultiline(node.operand, depth, opts);
    if (operandFormatted !== printNode(node.operand)) {
      return `not ${operandFormatted}`;
    }
    return oneLine;
  }

  // Group — check if contents need breaking
  if (node.kind === 'Group') {
    const oneLine = printNode(node);
    if (oneLine.length + ind.length <= opts.maxWidth) {
      return oneLine;
    }

    const inner = node.expression;

    // Group containing a logical chain — break the chain inside
    if (inner.kind === 'Logical') {
      const formatted = printLogicalChain(inner, depth + 1, opts);
      return `(\n${formatted}\n${ind})`;
    }

    // Group containing an in-expression with a long list
    if (inner.kind === 'InExpression') {
      const formatted = printInExpressionMultiline(inner, depth + 1, opts);
      if (formatted) return `(\n${formatted}\n${ind})`;
    }

    // Fallback: recursively try to break any inner node (e.g., nested Group, Not)
    const innerFormatted = printNodeMultiline(inner, depth + 1, opts);
    if (innerFormatted !== printNode(inner)) {
      const indInner = opts.indent.repeat(depth + 1);
      return `(\n${indInner}${innerFormatted}\n${ind})`;
    }

    return oneLine;
  }

  // Top-level logical chain
  if (node.kind === 'Logical') {
    return printLogicalChain(node, depth, opts);
  }

  return printNode(node);
}

/**
 * Print a logical chain (and/or) with each operand on its own line.
 * Groups same-operator chains together.
 */
function printLogicalChain(node: ASTNode, depth: number, opts: Required<FormatOptions>): string {
  const ind = opts.indent.repeat(depth);

  // Collect the chain — find the top-level operator
  if (node.kind !== 'Logical') {
    return `${ind}${printNodeMultiline(node, depth, opts)}`;
  }

  const topOp = normalizeOp(node.operator);
  const branches: ASTNode[] = [];
  collectChain(node, topOp, branches);

  const lines: string[] = [];
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];
    const formatted = printNodeMultiline(branch, depth, opts);

    if (i === 0) {
      lines.push(`${ind}${formatted}`);
    } else {
      lines.push(`${ind}${topOp} ${formatted}`);
    }
  }

  return lines.join('\n');
}

/** Collect branches of the same operator into a flat list. */
function collectChain(node: ASTNode, op: string, branches: ASTNode[]): void {
  if (node.kind === 'Logical' && normalizeOp(node.operator) === op) {
    collectChain(node.left, op, branches);
    collectChain(node.right, op, branches);
  } else {
    branches.push(node);
  }
}

/** Normalize operator to English form for consistency. */
function normalizeOp(op: string): string {
  switch (op) {
    case '&&': return 'and';
    case '||': return 'or';
    default: return op;
  }
}

/** Print an in-expression with values broken across lines if needed. */
function printInExpressionMultiline(node: ASTNode & { kind: 'InExpression' }, depth: number, opts: Required<FormatOptions>): string | null {
  const ind = opts.indent.repeat(depth);
  const field = printNode(node.field);
  const neg = node.negated ? 'not ' : '';
  const values = node.values.map(v => printNode(v));

  // Check if single line fits
  const oneLine = `${neg}${field} in {${values.join(' ')}}`;
  if (oneLine.length + ind.length <= opts.maxWidth) {
    return null; // Use single-line form
  }

  // Exceeds maxWidth — break to one value per line
  const indValues = opts.indent.repeat(depth + 1);
  const valueLines = values.map(v => `${indValues}${v}`).join('\n');
  return `${ind}${neg}${field} in {\n${valueLines}\n${ind}}`;
}

/** Escape special characters in a string literal. */
/** Escape for Cloudflare expression string literals.
 *  Only `"` needs escaping (to `\"`). Backslashes pass through as-is
 *  because they're regex escapes in Cloudflare expressions, not string escapes. */
function escapeString(s: string): string {
  return s.replace(/"/g, '\\"');
}
