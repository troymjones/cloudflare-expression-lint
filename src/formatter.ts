/**
 * Expression formatter/prettifier.
 *
 * Reformats Cloudflare expressions across multiple lines for readability,
 * breaking on logical operators and indenting nested groups.
 */

import { parse } from './parser.js';
import { substitutePlaceholders, restorePlaceholders } from './placeholders.js';
import { printNode, normalizeOp, collectChain } from './ast-utils.js';
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

