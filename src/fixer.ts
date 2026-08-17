/**
 * Auto-fixer for Cloudflare expressions.
 *
 * Transforms an AST to fix common Builder-incompatible patterns
 * and operator style issues. Returns the fixed expression string.
 */

import { parse } from './parser.js';
import { substitutePlaceholders, restorePlaceholders } from './placeholders.js';
import { printNode, normalizeOp, collectChain, stripGroup } from './ast-utils.js';
import { checkBuilderCompatibility } from './builder-compat.js';
import type { ASTNode, OperatorStyle, ExpressionType, Diagnostic } from './types.js';

export interface FixOptions {
  /** Operator style to enforce. Default: 'english' */
  operatorStyle?: OperatorStyle;
  /** Expression type. Rewrite/redirect expressions skip Builder-compat wrapping. */
  expressionType?: ExpressionType;
  /**
   * Restrict fixes to these diagnostic codes. Omit or leave empty to apply all.
   * Lets callers take the always-safe `builder-unwrapped` wraps without the
   * De Morgan and or-branch rewrites, which reshape a working expression.
   */
  fixOnly?: string[];
}

/** Diagnostic codes that `fixOnly` accepts. */
export const FIXABLE_CODES = [
  'builder-unwrapped',
  'builder-incompatible',
  'negated-comparison',
  'prefer-english-operator',
  'prefer-clike-operator',
  'prefer-in-list',
] as const;

function allows(options: FixOptions | undefined, code: string): boolean {
  const only = options?.fixOnly;
  return !only || only.length === 0 || only.includes(code);
}

const BUILDER_CODES = ['builder-unwrapped', 'builder-incompatible'];

/**
 * True when a scoped run should touch this expression at all: either it carries
 * one of the requested Builder codes, or a non-Builder code was requested and
 * those fixers can judge for themselves.
 */
function hasRequestedBuilderCode(ast: ASTNode, fixOnly: string[]): boolean {
  const builderRequested = fixOnly.filter(c => BUILDER_CODES.includes(c));
  if (builderRequested.length === 0) return true;
  if (fixOnly.some(c => !BUILDER_CODES.includes(c))) return true;

  const diagnostics: Diagnostic[] = [];
  checkBuilderCompatibility(ast, diagnostics);
  const present = new Set(diagnostics.map(d => d.code));
  return builderRequested.some(c => present.has(c));
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
  const trimmed = expression.trim();

  // Substitute placeholders so expressions with template vars can be parsed
  const { expression: substituted, map } = substitutePlaceholders(trimmed);

  let ast: ASTNode;
  try {
    ast = parse(substituted);
  } catch {
    return { expression: trimmed, changed: false, fixes: [] };
  }

  // Scoped runs must fix exactly what the matching diagnostic reports, or a
  // --check gate fails on expressions the linter never warned about. Ask the
  // checker which Builder codes this expression actually has, rather than
  // relying on the fixer's own predicates agreeing with the validator's.
  if (options?.fixOnly?.length && !hasRequestedBuilderCode(ast, options.fixOnly)) {
    return { expression: trimmed, changed: false, fixes: [] };
  }

  // Apply fixes to the AST
  const fixed = fixNode(ast, fixes, options);

  // Print and restore placeholders
  const result = restorePlaceholders(printNode(fixed), map);
  const originalCanonical = restorePlaceholders(printNode(ast), map);

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

  // Builder-compat fixes only apply to filter expressions.
  // Iterate because one fix can expose patterns for another
  // (e.g., Builder restructuring exposes or-eq chains).
  if (isFilter) {
    for (let pass = 0; pass < 5; pass++) {
      const before = printNode(fixed);
      fixed = fixNegatedComparison(fixed, fixes, options);
      fixed = fixOrEqToIn(fixed, fixes, options);
      fixed = fixDeMorgans(fixed, fixes, options);
      fixed = fixBuilderStructure(fixed, fixes, options);
      if (printNode(fixed) === before) break;
    }
  }

  return fixed;
}

/** Fix operator style (C-like ↔ English) */
function fixOperatorStyle(node: ASTNode, fixes: string[], options?: FixOptions): ASTNode {
  const style = options?.operatorStyle ?? 'english';
  if (style === 'off') return node;
  const styleCode = style === 'english' ? 'prefer-english-operator' : 'prefer-clike-operator';
  if (!allows(options, styleCode)) return node;

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

/**
 * Collapse or-chains of eq comparisons on the same field into an in-list.
 * (A eq "x") or (A eq "y") or (A eq "z") → (A in {"x" "y" "z"})
 * Recurses into Groups to find nested or-chains.
 */
function fixOrEqToIn(node: ASTNode, fixes: string[], options?: FixOptions): ASTNode {
  if (!allows(options, 'prefer-in-list')) return node;
  if (node.kind === 'Group') {
    const fixed = fixOrEqToIn(node.expression, fixes, options);
    return fixed !== node.expression ? { ...node, expression: fixed } : node;
  }

  if (node.kind === 'Logical') {
    // For or-chains: collect ALL branches first, then check the pattern
    if (isAllOp(node, 'or')) {
      const branches: ASTNode[] = [];
      collectChain(node, 'or', branches);

      if (branches.length >= 3) {
        const fieldName = extractEqField(branches[0]);
        if (fieldName) {
          const values: ASTNode[] = [];
          let allMatch = true;
          for (const branch of branches) {
            const stripped = stripGroup(branch);
            if (stripped.kind !== 'Comparison' || normalizeOp(stripped.operator) !== 'eq' || printNode(stripped.left) !== fieldName) {
              allMatch = false;
              break;
            }
            values.push(stripped.right);
          }
          if (allMatch) {
            fixes.push(`collapse ${branches.length} or-eq branches to in-list`);
            const inExpr: ASTNode = {
              kind: 'InExpression',
              field: (stripGroup(branches[0]) as any).left,
              values,
              negated: false,
              position: node.position,
            };
            return buildGroup(inExpr);
          }
        }
      }
    }

    // For and-chains or non-matching or-chains: recurse into children
    const left = fixOrEqToIn(node.left, fixes, options);
    const right = fixOrEqToIn(node.right, fixes, options);
    return (left !== node.left || right !== node.right) ? { ...node, left, right } : node;
  }

  return node;
}

/** Extract the field name from an or-branch if it's (field eq "value") */
function extractEqField(branch: ASTNode): string | null {
  const inner = stripGroup(branch);
  if (inner.kind !== 'Comparison') return null;
  if (normalizeOp(inner.operator) !== 'eq') return null;
  return printNode(inner.left);
}

/** Fix De Morgan's law: not (A or B) → (not A and not B), not (A and B) → (not A) or (not B) */
/**
 * Rewrite `not X eq Y` → `X ne Y` and `not X ne Y` → `X eq Y`.
 * Skip when the LHS is a function call or array unpack (no clean inverse).
 * The Comparison is unwrapped from any immediate Group inside the Not, which
 * matches how the parser produces `not (X eq Y)`.
 */
function fixNegatedComparison(node: ASTNode, fixes: string[], options?: FixOptions): ASTNode {
  if (!allows(options, 'negated-comparison')) return node;
  switch (node.kind) {
    case 'Not': {
      const operand = fixNegatedComparison(node.operand, fixes, options);
      const inner = operand.kind === 'Group' ? operand.expression : operand;
      if (inner.kind === 'Comparison') {
        const op = normalizeOp(inner.operator);
        if (op === 'eq' || op === 'ne') {
          if (inner.left.kind !== 'FunctionCall' && inner.left.kind !== 'ArrayUnpack') {
            const flipped = op === 'eq' ? 'ne' : 'eq';
            fixes.push(`negated comparison: not ... ${op} → ${flipped}`);
            return { ...inner, operator: flipped };
          }
        }
      }
      return operand !== node.operand ? { ...node, operand } : node;
    }
    case 'Logical':
      return {
        ...node,
        left: fixNegatedComparison(node.left, fixes, options),
        right: fixNegatedComparison(node.right, fixes, options),
      };
    case 'Group':
      return { ...node, expression: fixNegatedComparison(node.expression, fixes, options) };
    default:
      return node;
  }
}

function fixDeMorgans(node: ASTNode, fixes: string[], options?: FixOptions): ASTNode {
  if (!allows(options, 'builder-incompatible')) return node;
  switch (node.kind) {
    case 'Not': {
      const operand = fixDeMorgans(node.operand, fixes, options);
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
            return buildGroup(buildOrChain(negated));
          }
        }
      }

      // not (A) where A is a simple condition → keep as-is (already wrappable)
      return operand !== node.operand ? { ...node, operand } : node;
    }

    case 'Logical':
      return {
        ...node,
        left: fixDeMorgans(node.left, fixes, options),
        right: fixDeMorgans(node.right, fixes, options),
      };
    case 'Group':
      return { ...node, expression: fixDeMorgans(node.expression, fixes, options) };
    default:
      return node;
  }
}

/** Fix top-level structure for Builder compatibility */
function fixBuilderStructure(node: ASTNode, fixes: string[], options?: FixOptions): ASTNode {
  // Bare comparison/in/function at top level → wrap in group
  if (node.kind === 'Comparison' || node.kind === 'InExpression' || node.kind === 'FunctionCall') {
    if (!allows(options, 'builder-unwrapped')) return node;
    fixes.push('wrap bare expression in parentheses');
    return buildGroup(node);
  }

  // Bare not at top level → wrap: not A → (not A)
  if (node.kind === 'Not' && node.operand.kind !== 'Group') {
    if (!allows(options, 'builder-unwrapped')) return node;
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
      if (!allows(options, 'builder-incompatible')) return node;
      // (A) and (B) → (A and B): unwrap inner groups and merge
      // Also flatten nested and-chains: ((A and B)) and (C) → (A and B and C)
      const allLeaves: ASTNode[] = [];
      for (const leaf of leaves) {
        const stripped = stripGroup(leaf);
        if (stripped.kind === 'Logical' && isAllOp(stripped, 'and')) {
          collectChain(stripped, 'and', allLeaves);
        } else {
          allLeaves.push(stripped);
        }
      }

      // Preserve (cf.zone.plan eq "ENT") as a separate top-level suffix
      // for account-level expressions. Merging it into the group would break
      // the validator's isZonePlanSuffixed check.
      const lastLeaf = allLeaves[allLeaves.length - 1];
      const isZonePlanSuffix = lastLeaf.kind === 'Comparison'
        && lastLeaf.left.kind === 'FieldAccess' && lastLeaf.left.field === 'cf.zone.plan'
        && lastLeaf.right.kind === 'StringLiteral' && lastLeaf.right.value === 'ENT';

      if (isZonePlanSuffix) {
        // Account-level: Builder requires ((inner)) and (cf.zone.plan eq "ENT")
        // The inner expression gets double-wrapped (exactly 2 layers, not 1, not 3).
        const mainLeaves = allLeaves.slice(0, -1);
        const suffixGroup = buildGroup(lastLeaf);

        if (mainLeaves.every(l => isSimpleCondition(l) || l.kind === 'Not')) {
          // Fix inner with normal Builder rules, then double-wrap
          let innerFixed: ASTNode;
          if (mainLeaves.length === 1) {
            innerFixed = mainLeaves[0];
          } else {
            innerFixed = buildAndChain(mainLeaves);
          }
          const doubleWrapped = buildGroup(buildGroup(innerFixed));
          const result: ASTNode = { kind: 'Logical', left: doubleWrapped, operator: 'and', right: suffixGroup, position: 0 };
          const resultStr = printNode(result);
          const originalStr = printNode(node);
          if (resultStr !== originalStr) {
            fixes.push('fix Builder format for account-level expression');
          }
          return result;
        }

        // Inner has complex structure (or-chain, nested groups) — fix inner, wrap once more
        if (mainLeaves.length === 1) {
          const inner = mainLeaves[0];
          // Fix the inner expression with normal Builder rules
          const fixedInner = fixBuilderStructure(stripGroup(inner), fixes, options);
          // Wrap once: normal Builder form + 1 extra group for account-level
          const wrapped = buildGroup(fixedInner);
          const result: ASTNode = { kind: 'Logical', left: wrapped, operator: 'and', right: suffixGroup, position: 0 };
          const resultStr = printNode(result);
          const originalStr = printNode(node);
          if (resultStr !== originalStr && fixes.length === 0) {
            fixes.push('fix Builder format for account-level expression');
          }
          return result;
        }
      } else if (allLeaves.every(l => isSimpleCondition(l) || l.kind === 'Not')) {
        fixes.push('merge (A) and (B) → (A and B)');
        return buildGroup(buildAndChain(allLeaves));
      }
    } else {
      // Bare A and B → (A and B)
      if (leaves.every(l => isSimpleCondition(l) || l.kind === 'Not')) {
        if (!allows(options, 'builder-unwrapped')) return node;
        fixes.push('wrap and-chain in parentheses');
        return buildGroup(node);
      }
    }
  }

  // Top-level or-chain → ensure each branch is wrapped
  if (node.kind === 'Logical' && isAllOp(node, 'or')) {
    if (!allows(options, 'builder-incompatible')) return node;
    const branches: ASTNode[] = [];
    collectChain(node, 'or', branches);

    let changed = false;
    const fixedBranches = branches.map(b => {
      if (b.kind === 'Group') {
        // Already wrapped — fix inner individually-wrapped and-conditions
        const inner = b.expression;
        if (inner.kind === 'Logical' && isAllOp(inner, 'and')) {
          const fixed = fixInnerAndGroup(inner, fixes, options);
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
        const fixed = fixInnerAndGroup(b, fixes, options);
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
    if (!allows(options, 'builder-incompatible')) return node;
    fixes.push('remove outer parentheses from or-chain');
    return fixBuilderStructure(node.expression, fixes, options);
  }

  // Group containing and-chain with individually-wrapped conditions
  if (node.kind === 'Group' && node.expression.kind === 'Logical' && isAllOp(node.expression, 'and')) {
    const fixed = fixInnerAndGroup(node.expression, fixes, options);
    if (fixed !== node.expression) {
      return { ...node, expression: fixed };
    }
  }

  return node;
}

/** Fix individually-wrapped conditions in an and-group: (A) and (B) → A and B */
function fixInnerAndGroup(node: ASTNode, fixes: string[], options?: FixOptions): ASTNode {
  if (!allows(options, 'builder-incompatible')) return node;
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

