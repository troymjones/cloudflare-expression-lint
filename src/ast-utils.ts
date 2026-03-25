/**
 * Shared AST utility functions.
 *
 * Canonical implementations of printNode, normalizeOp, collectChain,
 * stripGroup, and escapeString used by the fixer, formatter, and rewriter.
 */

import type { ASTNode } from './types.js';

/** Print an AST node as a single-line string (canonical form). */
export function printNode(node: ASTNode): string {
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
      if (node.values.length === 1 && node.values[0].kind === 'NamedList') {
        return `${neg}${field} in ${printNode(node.values[0])}`;
      }
      const values = node.values.map(v => printNode(v)).join(' ');
      return `${neg}${field} in {${values}}`;
    }

    case 'Group':
      return `(${printNode(node.expression)})`;

    case 'ArrayUnpack':
      return `${printNode(node.field)}[*]`;
  }
}

/** Normalize operator to English form for consistency. */
export function normalizeOp(op: string): string {
  if (op === '&&') return 'and';
  if (op === '||') return 'or';
  return op;
}

/** Collect branches of the same operator into a flat list. */
export function collectChain(node: ASTNode, op: string, branches: ASTNode[]): void {
  if (node.kind === 'Logical' && normalizeOp(node.operator) === op) {
    collectChain(node.left, op, branches);
    collectChain(node.right, op, branches);
  } else {
    branches.push(node);
  }
}

/** Strip all Group wrappers from a node. */
export function stripGroup(node: ASTNode): ASTNode {
  while (node.kind === 'Group') node = node.expression;
  return node;
}

/** Escape for Cloudflare expression string literals.
 *  Only `"` needs escaping (to `\"`). Backslashes pass through as-is
 *  because they're regex escapes in Cloudflare expressions, not string escapes. */
export function escapeString(s: string): string {
  return s.replace(/"/g, '\\"');
}
