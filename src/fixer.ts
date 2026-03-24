/**
 * Auto-fixer for Cloudflare expressions.
 *
 * Transforms an AST to fix common Builder-incompatible patterns
 * and operator style issues. Returns the fixed expression string.
 */

import { parse } from './parser.js';
import type { ASTNode, OperatorStyle, ExpressionType } from './types.js';

export interface FixOptions {
  /** Operator style to enforce. Default: 'english' */
  operatorStyle?: OperatorStyle;
  /** Expression type. Rewrite/redirect expressions skip Builder-compat wrapping. */
  expressionType?: ExpressionType;
}

export interface FixResult {
  /** The fixed expression string */
  expression: string;
  /** Whether any changes were made */
  changed: boolean;
  /** Descriptions of fixes applied */
  fixes: string[];
}

const CLIKE_TO_ENGLISH: Record<string, string> = {
  '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge',
  '~': 'matches', '&&': 'and', '||': 'or', '!': 'not', '^^': 'xor',
};

const ENGLISH_TO_CLIKE: Record<string, string> = {
  'eq': '==', 'ne': '!=', 'lt': '<', 'le': '<=', 'gt': '>', 'ge': '>=',
  'matches': '~', 'and': '&&', 'or': '||', 'not': '!', 'xor': '^^',
};

/**
 * Fix a Cloudflare expression for Builder compatibility and style.
 */
export function fixExpression(expression: string, options?: FixOptions): FixResult {
  const fixes: string[] = [];

  let ast: ASTNode;
  try {
    ast = parse(expression.trim());
  } catch {
    return { expression: expression.trim(), changed: false, fixes: [] };
  }

  // Apply fixes to the AST
  const fixed = fixNode(ast, fixes, options);

  // Print the fixed AST
  const result = printNode(fixed);

  // Compare against the canonical form of the original (re-printed from AST)
  // to avoid false positives from whitespace differences in >- block scalars
  const originalCanonical = printNode(ast);

  return {
    expression: result,
    changed: result !== originalCanonical,
    fixes: result !== originalCanonical ? fixes : [],
  };
}

// ── AST Fixers ───────────────────────────────────────────────────────

function fixNode(node: ASTNode, fixes: string[], options?: FixOptions): ASTNode {
  const isFilter = !options?.expressionType || options.expressionType === 'filter';

  // Fix operator style first (deepest nodes first)
  let fixed = fixOperatorStyle(node, fixes, options);

  // Builder-compat fixes only apply to filter expressions
  if (isFilter) {
    // Fix De Morgan's: not (A or B) → (not A and not B)
    fixed = fixDeMorgans(fixed, fixes);

    // Fix top-level structure for Builder compatibility
    fixed = fixBuilderStructure(fixed, fixes);
  }

  return fixed;
}

/** Fix operator style (C-like ↔ English) */
function fixOperatorStyle(node: ASTNode, fixes: string[], options?: FixOptions): ASTNode {
  const style = options?.operatorStyle ?? 'english';
  if (style === 'off') return node;

  const flagMap = style === 'english' ? CLIKE_TO_ENGLISH : ENGLISH_TO_CLIKE;

  switch (node.kind) {
    case 'Comparison': {
      const left = fixOperatorStyle(node.left, fixes, options);
      const right = fixOperatorStyle(node.right, fixes, options);
      const newOp = flagMap[node.operator];
      if (newOp) {
        fixes.push(`operator: ${node.operator} → ${newOp}`);
        return { ...node, left, right, operator: newOp };
      }
      return left !== node.left || right !== node.right
        ? { ...node, left, right } : node;
    }
    case 'Logical': {
      const left = fixOperatorStyle(node.left, fixes, options);
      const right = fixOperatorStyle(node.right, fixes, options);
      const newOp = flagMap[node.operator];
      if (newOp) {
        fixes.push(`operator: ${node.operator} → ${newOp}`);
        return { ...node, left, right, operator: newOp };
      }
      return left !== node.left || right !== node.right
        ? { ...node, left, right } : node;
    }
    case 'Not':
      return { ...node, operand: fixOperatorStyle(node.operand, fixes, options) };
    case 'Group':
      return { ...node, expression: fixOperatorStyle(node.expression, fixes, options) };
    case 'InExpression':
      return { ...node, field: fixOperatorStyle(node.field, fixes, options) };
    case 'FunctionCall':
      return { ...node, args: node.args.map(a => fixOperatorStyle(a, fixes, options)) };
    default:
      return node;
  }
}

/** Fix De Morgan's law: not (A or B) → (not A and not B), not (A and B) → (not A) or (not B) */
function fixDeMorgans(node: ASTNode, fixes: string[]): ASTNode {
  switch (node.kind) {
    case 'Not': {
      const operand = fixDeMorgans(node.operand, fixes);
      // not (A or B) → not A and not B (will be wrapped later)
      if (operand.kind === 'Group' && operand.expression.kind === 'Logical') {
        const inner = operand.expression;
        const op = normalizeOp(inner.operator);

        if (op === 'or') {
          // not (A or B) → not A and not B (no group — let fixBuilderStructure wrap)
          const branches: ASTNode[] = [];
          collectChain(inner, 'or', branches);

          // Only fix if all branches are simple conditions
          if (branches.every(b => isSimpleCondition(b))) {
            fixes.push('De Morgan: not (A or B) → (not A and not B)');
            const negated = branches.map(b => wrapNot(stripGroup(b)));
            return buildAndChain(negated);
          }
        }

        if (op === 'and') {
          // not (A and B) → (not A) or (not B)
          const branches: ASTNode[] = [];
          collectChain(inner, 'and', branches);

          if (branches.every(b => isSimpleCondition(b))) {
            fixes.push('De Morgan: not (A and B) → (not A) or (not B)');
            const negated = branches.map(b => buildGroup(wrapNot(stripGroup(b))));
            return buildOrChain(negated);
          }
        }
      }

      // not (A) where A is a simple condition → keep as-is (already wrappable)
      return operand !== node.operand ? { ...node, operand } : node;
    }

    case 'Logical':
      return {
        ...node,
        left: fixDeMorgans(node.left, fixes),
        right: fixDeMorgans(node.right, fixes),
      };
    case 'Group':
      return { ...node, expression: fixDeMorgans(node.expression, fixes) };
    default:
      return node;
  }
}

/** Fix top-level structure for Builder compatibility */
function fixBuilderStructure(node: ASTNode, fixes: string[]): ASTNode {
  // Bare comparison/in/function at top level → wrap in group
  if (node.kind === 'Comparison' || node.kind === 'InExpression' || node.kind === 'FunctionCall') {
    fixes.push('wrap bare expression in parentheses');
    return buildGroup(node);
  }

  // Bare not at top level → wrap: not A → (not A)
  if (node.kind === 'Not' && node.operand.kind !== 'Group') {
    fixes.push('wrap not expression in parentheses');
    return buildGroup(node);
  }

  // Top-level and-chain without wrapping → wrap: A and B → (A and B)
  if (node.kind === 'Logical' && isAllOp(node, 'and')) {
    const leaves: ASTNode[] = [];
    collectChain(node, 'and', leaves);

    // Check if any leaves are Groups (the (A) and (B) pattern)
    const hasGroups = leaves.some(l => l.kind === 'Group');
    if (hasGroups) {
      // (A) and (B) → (A and B): unwrap inner groups and merge
      const unwrapped = leaves.map(l => stripGroup(l));
      if (unwrapped.every(l => isSimpleCondition(l) || l.kind === 'Not')) {
        fixes.push('merge (A) and (B) → (A and B)');
        return buildGroup(buildAndChain(unwrapped));
      }
    } else {
      // Bare A and B → (A and B)
      if (leaves.every(l => isSimpleCondition(l) || l.kind === 'Not')) {
        fixes.push('wrap and-chain in parentheses');
        return buildGroup(node);
      }
    }
  }

  // Top-level or-chain → ensure each branch is wrapped
  if (node.kind === 'Logical' && isAllOp(node, 'or')) {
    const branches: ASTNode[] = [];
    collectChain(node, 'or', branches);

    let changed = false;
    const fixedBranches = branches.map(b => {
      if (b.kind === 'Group') {
        // Already wrapped — fix inner individually-wrapped and-conditions
        const inner = b.expression;
        if (inner.kind === 'Logical' && isAllOp(inner, 'and')) {
          const fixed = fixInnerAndGroup(inner, fixes);
          if (fixed !== inner) {
            changed = true;
            return buildGroup(fixed);
          }
        }
        return b;
      }
      // Unwrapped branch — wrap it
      changed = true;
      if (b.kind === 'Logical' && isAllOp(b, 'and')) {
        fixes.push('wrap or-branch in parentheses');
        const fixed = fixInnerAndGroup(b, fixes);
        return buildGroup(fixed);
      }
      if (isSimpleCondition(b) || b.kind === 'Not' || b.kind === 'FunctionCall') {
        fixes.push('wrap or-branch in parentheses');
        return buildGroup(b);
      }
      return b;
    });

    if (changed) {
      return buildOrChain(fixedBranches);
    }
  }

  // Group containing or-chain → remove outer group: ((A) or (B)) → (A) or (B)
  if (node.kind === 'Group' && node.expression.kind === 'Logical' && isAllOp(node.expression, 'or')) {
    fixes.push('remove outer parentheses from or-chain');
    return fixBuilderStructure(node.expression, fixes);
  }

  // Group containing and-chain with individually-wrapped conditions
  if (node.kind === 'Group' && node.expression.kind === 'Logical' && isAllOp(node.expression, 'and')) {
    const fixed = fixInnerAndGroup(node.expression, fixes);
    if (fixed !== node.expression) {
      return { ...node, expression: fixed };
    }
  }

  return node;
}

/** Fix individually-wrapped conditions in an and-group: (A) and (B) → A and B */
function fixInnerAndGroup(node: ASTNode, fixes: string[]): ASTNode {
  if (node.kind !== 'Logical') return node;

  const leaves: ASTNode[] = [];
  collectChain(node, 'and', leaves);

  const hasWrapped = leaves.some(l =>
    l.kind === 'Group' && isSimpleCondition(l.expression)
  );

  if (!hasWrapped) return node;

  const unwrapped = leaves.map(l => {
    if (l.kind === 'Group' && (isSimpleCondition(l.expression) || l.expression.kind === 'Not')) {
      return l.expression;
    }
    return l;
  });

  fixes.push('unwrap individually-wrapped conditions in and-group');
  return buildAndChain(unwrapped);
}

// ── Helpers ──────────────────────────────────────────────────────────

function isSimpleCondition(node: ASTNode): boolean {
  return node.kind === 'Comparison' || node.kind === 'InExpression'
    || node.kind === 'FieldAccess' || node.kind === 'BooleanLiteral'
    || node.kind === 'FunctionCall';
}

function isAllOp(node: ASTNode, op: string): boolean {
  if (node.kind !== 'Logical') return true;
  const nodeOp = normalizeOp(node.operator);
  if (nodeOp !== op) return false;
  return isAllOp(node.left, op) && isAllOp(node.right, op);
}

function normalizeOp(op: string): string {
  if (op === '&&') return 'and';
  if (op === '||') return 'or';
  return op;
}

function collectChain(node: ASTNode, op: string, branches: ASTNode[]): void {
  if (node.kind === 'Logical' && normalizeOp(node.operator) === op) {
    collectChain(node.left, op, branches);
    collectChain(node.right, op, branches);
  } else {
    branches.push(node);
  }
}

function stripGroup(node: ASTNode): ASTNode {
  return node.kind === 'Group' ? node.expression : node;
}

function wrapNot(node: ASTNode): ASTNode {
  // Don't double-negate
  if (node.kind === 'Not') return node.operand;
  return { kind: 'Not', operand: node, position: node.position };
}

function buildGroup(inner: ASTNode): ASTNode {
  return { kind: 'Group', expression: inner, position: 0 };
}

function buildAndChain(nodes: ASTNode[]): ASTNode {
  let result = nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    result = { kind: 'Logical', left: result, operator: 'and', right: nodes[i], position: 0 };
  }
  return result;
}

function buildOrChain(nodes: ASTNode[]): ASTNode {
  let result = nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    result = { kind: 'Logical', left: result, operator: 'or', right: nodes[i], position: 0 };
  }
  return result;
}

// ── AST Printer ──────────────────────────────────────────────────────

function printNode(node: ASTNode): string {
  switch (node.kind) {
    case 'BooleanLiteral':
      return String(node.value);
    case 'StringLiteral':
      if (node.raw) return `r"${node.value}"`;
      return `"${node.value.replace(/"/g, '\\"')}"`;
    case 'IntegerLiteral':
    case 'FloatLiteral':
      return String(node.value);
    case 'IPLiteral':
      return node.cidr !== undefined ? `${node.value}/${node.cidr}` : node.value;
    case 'FieldAccess': {
      let s = node.field;
      if (node.mapKey !== undefined) s += `["${node.mapKey.replace(/"/g, '\\"')}"]`;
      if (node.arrayIndex !== undefined) s += `[${node.arrayIndex}]`;
      return s;
    }
    case 'NamedList':
      return node.name.startsWith('$') ? node.name : `$${node.name}`;
    case 'FunctionCall':
      return `${node.name}(${node.args.map(a => printNode(a)).join(', ')})`;
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
      return `${neg}${field} in {${node.values.map(v => printNode(v)).join(' ')}}`;
    }
    case 'Group':
      return `(${printNode(node.expression)})`;
    case 'ArrayUnpack':
      return `${printNode(node.field)}[*]`;
  }
}
