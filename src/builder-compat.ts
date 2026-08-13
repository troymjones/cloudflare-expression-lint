/**
 * Expression Builder compatibility checker.
 *
 * Checks whether a Cloudflare expression can be represented in the
 * Cloudflare Dashboard's Expression Builder UI. Structural issues are
 * info-level; a missing outer wrap is `builder-unwrapped` at warning
 * level, since it is always mechanically fixable by `--fix`.
 */

import type { ASTNode, Diagnostic } from './types.js';

/** Check an expression for Builder compatibility issues. */
export function checkBuilderCompatibility(ast: ASTNode, diagnostics: Diagnostic[]): void {
  if (containsNonBuilderFunction(ast)) return;
  if (ast.kind === 'BooleanLiteral' || ast.kind === 'FieldAccess') return;

  if (ast.kind === 'Comparison' || ast.kind === 'InExpression' || ast.kind === 'FunctionCall') {
    diagnostics.push({
      severity: 'warning',
      message: 'Wrap in parentheses for Expression Builder compatibility: (field op value)',
      code: 'builder-unwrapped',
    });
    return;
  }

  if (ast.kind === 'Not') {
    checkNotCompatibility(ast, diagnostics);
    return;
  }

  if (ast.kind === 'Group') {
    checkGroupCompatibility(ast, diagnostics);
    return;
  }

  if (ast.kind === 'Logical') {
    checkLogicalCompatibility(ast, diagnostics);
    return;
  }
}

/** Check that account-level expressions end with `and (cf.zone.plan eq "ENT")`. */
export function checkAccountLevelSuffix(ast: ASTNode, diagnostics: Diagnostic[]): void {
  if (ast.kind === 'Group') {
    const inner = ast.expression;
    if (inner.kind === 'Comparison' &&
        inner.left.kind === 'FieldAccess' &&
        inner.left.field === 'cf.zone.plan') {
      return;
    }
  }

  if (!isZonePlanSuffixed(ast)) {
    diagnostics.push({
      severity: 'warning',
      message: 'Account-level expression should end with `and (cf.zone.plan eq "ENT")` to scope to Enterprise zones',
      code: 'missing-zone-plan-filter',
    });
  }
}

/** Check if an AST node ends with `and (cf.zone.plan eq "ENT")`. */
export function isZonePlanSuffixed(ast: ASTNode): boolean {
  if (ast.kind !== 'Logical') return false;
  if (ast.operator !== 'and' && ast.operator !== '&&') return false;

  let right = ast.right;
  if (right.kind === 'Group') right = right.expression;

  if (right.kind !== 'Comparison') return false;
  if (right.left.kind !== 'FieldAccess') return false;
  if (right.left.field !== 'cf.zone.plan') return false;
  if (right.right.kind !== 'StringLiteral') return false;
  if (right.right.value !== 'ENT') return false;

  return true;
}

// ── Internal helpers ─────────────────────────────────────────────────

function checkNotCompatibility(ast: ASTNode & { kind: 'Not' }, diagnostics: Diagnostic[]): void {
  if (ast.operand.kind === 'Group') {
    const inner = ast.operand.expression;
    if (isBuilderCondition(inner)) {
      diagnostics.push({
        severity: 'info',
        message: 'Move `not` inside the group for Expression Builder compatibility: (not A) instead of not (A)',
        code: 'builder-incompatible',
      });
    } else if (inner.kind === 'Logical' && isTopLevelOr(inner)) {
      diagnostics.push({
        severity: 'info',
        message: 'Rewrite using De Morgan\'s law for Expression Builder compatibility: not (A or B) → (not A and not B)',
        code: 'builder-incompatible',
      });
    } else if (inner.kind === 'Logical' && isTopLevelAnd(inner)) {
      diagnostics.push({
        severity: 'info',
        message: 'Rewrite using De Morgan\'s law for Expression Builder compatibility: not (A and B) → (not A) or (not B)',
        code: 'builder-incompatible',
      });
    } else {
      diagnostics.push({
        severity: 'info',
        message: 'Top-level `not (...)` is not Expression Builder compatible',
        code: 'builder-incompatible',
      });
    }
  } else {
    diagnostics.push({
      severity: 'warning',
      message: 'Wrap in parentheses for Expression Builder compatibility: (not field op value)',
      code: 'builder-unwrapped',
    });
  }
}

function checkGroupCompatibility(ast: ASTNode & { kind: 'Group' }, diagnostics: Diagnostic[]): void {
  const inner = ast.expression;

  if (isBuilderCondition(inner)) return;
  if (inner.kind === 'Not' && isBuilderCondition(inner.operand)) return;
  if (inner.kind === 'Logical' && isTopLevelAnd(inner) && isBuilderAndGroup(inner)) return;

  if (inner.kind === 'Logical' && isTopLevelOr(inner)) {
    diagnostics.push({
      severity: 'info',
      message: 'Remove outer parentheses from or-chain for Expression Builder compatibility. Use (A) or (B) instead of ((A) or (B)).',
      code: 'builder-incompatible',
    });
    return;
  }

  if (inner.kind === 'Logical' && isTopLevelAnd(inner) && !isBuilderAndGroup(inner)) {
    diagnostics.push({
      severity: 'info',
      message: 'Expression contains `or` nested inside an `and` group, which is not Expression Builder compatible. Consider distributing: ((A or B) and C) → (A and C) or (B and C)',
      code: 'builder-incompatible',
    });
    return;
  }

  if (inner.kind === 'Logical' || inner.kind === 'Not') {
    diagnostics.push({
      severity: 'info',
      message: 'Expression inside group is not Expression Builder compatible',
      code: 'builder-incompatible',
    });
  }
}

function checkLogicalCompatibility(ast: ASTNode & { kind: 'Logical' }, diagnostics: Diagnostic[]): void {
  if (isTopLevelOr(ast)) {
    const branches: ASTNode[] = [];
    collectOrBranches(ast, branches);

    const unwrapped: ASTNode[] = [];
    for (const branch of branches) {
      if (branch.kind === 'Group') {
        if (isValidBuilderGroup(branch)) continue;
        diagnostics.push({
          severity: 'info',
          message: 'Or-branch contains expressions not compatible with Expression Builder',
          code: 'builder-incompatible',
        });
        return;
      }
      unwrapped.push(branch);
    }

    if (unwrapped.length > 0) {
      diagnostics.push({
        severity: 'info',
        message: `Wrap each or-branch in parentheses for Expression Builder compatibility: (A) or (B). ${unwrapped.length} of ${branches.length} branch(es) need wrapping.`,
        code: 'builder-incompatible',
      });
    }
    return;
  }

  if (isTopLevelAnd(ast)) {
    const andLeaves: ASTNode[] = [];
    collectAndLeaves(ast, andLeaves);
    const hasGroupLeaves = andLeaves.some(l => l.kind === 'Group');

    if (hasGroupLeaves) {
      const allSimpleGroups = andLeaves.every(l =>
        l.kind === 'Group' ? isValidBuilderGroup(l) : isBuilderAndLeaf(l)
      );
      if (allSimpleGroups) {
        diagnostics.push({
          severity: 'info',
          message: 'Merge and-groups into a single group for Expression Builder compatibility: (A) and (B) → (A and B)',
          code: 'builder-incompatible',
        });
      } else {
        diagnostics.push({
          severity: 'info',
          message: 'Top-level `and` between complex expressions is not Expression Builder compatible',
          code: 'builder-incompatible',
        });
      }
    } else if (isBuilderAndGroup(ast)) {
      diagnostics.push({
        severity: 'warning',
        message: 'Wrap and-chain in parentheses for Expression Builder compatibility: (A and B and C)',
        code: 'builder-unwrapped',
      });
    } else {
      diagnostics.push({
        severity: 'info',
        message: 'Top-level `and` between complex expressions is not Expression Builder compatible',
        code: 'builder-incompatible',
      });
    }
  }
}

/**
 * Check if a LEAF condition contains patterns that can't be in the Builder.
 * Only checks individual conditions, NOT the overall expression structure.
 * - `lower(field) eq "x"` — function as LHS of comparison, NOT Builder-compatible
 * - `any(field[*] op value)` — IS Builder-compatible (Builder UI supports it)
 * - `starts_with(field, value)` — IS Builder-compatible
 */
function isNonBuilderLeaf(node: ASTNode): boolean {
  if (node.kind === 'Comparison') {
    // Function as LHS of comparison: lower(field) eq "x" — not Builder
    if (node.left.kind === 'FunctionCall' || node.left.kind === 'ArrayUnpack') return true;
    return false;
  }
  if (node.kind === 'InExpression') {
    // Function/unpack as field in in-expression — not Builder
    if (node.field.kind === 'FunctionCall' || node.field.kind === 'ArrayUnpack') return true;
    return false;
  }
  return false;
}

/** Check if the expression contains any leaf that's inherently non-Builder.
 *  Recurses through logical/group/not structure but delegates to isNonBuilderLeaf
 *  for individual conditions. This allows structural checks (top-level and between
 *  groups, etc.) to still run on expressions containing any()/all() with [*]. */
function containsNonBuilderFunction(node: ASTNode): boolean {
  switch (node.kind) {
    case 'Comparison':
    case 'InExpression':
      return isNonBuilderLeaf(node);
    case 'FunctionCall':
      // Top-level function calls (starts_with, ends_with, any, all) are Builder-compatible
      return false;
    case 'Logical':
      return containsNonBuilderFunction(node.left) || containsNonBuilderFunction(node.right);
    case 'Not':
      return containsNonBuilderFunction(node.operand);
    case 'Group':
      return containsNonBuilderFunction(node.expression);
    default:
      return false;
  }
}

function isBuilderCondition(node: ASTNode): boolean {
  return node.kind === 'Comparison' || node.kind === 'InExpression'
    || node.kind === 'FieldAccess' || node.kind === 'BooleanLiteral'
    || node.kind === 'FunctionCall';
}

function isBuilderAndLeaf(node: ASTNode): boolean {
  if (isBuilderCondition(node)) return true;
  if (node.kind === 'Not') return isBuilderCondition(node.operand);
  return false;
}

function isBuilderAndGroup(node: ASTNode): boolean {
  if (node.kind === 'Logical') {
    if (node.operator !== 'and' && node.operator !== '&&') return false;
    return isBuilderAndGroup(node.left) && isBuilderAndGroup(node.right);
  }
  return isBuilderAndLeaf(node);
}

function isValidBuilderGroup(node: ASTNode): boolean {
  if (node.kind !== 'Group') return false;
  const inner = node.expression;
  if (isBuilderCondition(inner)) return true;
  if (inner.kind === 'Not' && isBuilderCondition(inner.operand)) return true;
  if (inner.kind === 'Logical' && isTopLevelAnd(inner) && isBuilderAndGroup(inner)) return true;
  return false;
}

function isTopLevelAnd(node: ASTNode): boolean {
  if (node.kind !== 'Logical') return true;
  if (node.operator !== 'and' && node.operator !== '&&') return false;
  return isTopLevelAnd(node.left) && isTopLevelAnd(node.right);
}

function isTopLevelOr(node: ASTNode): boolean {
  if (node.kind !== 'Logical') return true;
  if (node.operator !== 'or' && node.operator !== '||') return false;
  if (node.left.kind === 'Logical' && (node.left.operator === 'or' || node.left.operator === '||')) {
    return isTopLevelOr(node.left);
  }
  return true;
}

function collectOrBranches(node: ASTNode, branches: ASTNode[]): void {
  if (node.kind === 'Logical' && (node.operator === 'or' || node.operator === '||')) {
    collectOrBranches(node.left, branches);
    collectOrBranches(node.right, branches);
  } else {
    branches.push(node);
  }
}

function collectAndLeaves(node: ASTNode, leaves: ASTNode[]): void {
  if (node.kind === 'Logical' && (node.operator === 'and' || node.operator === '&&')) {
    collectAndLeaves(node.left, leaves);
    collectAndLeaves(node.right, leaves);
  } else {
    leaves.push(node);
  }
}
