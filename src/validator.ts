/**
 * Validator for Cloudflare expressions.
 *
 * Performs semantic analysis on the AST:
 * - Field existence and deprecation checks
 * - Phase-specific field availability
 * - Function existence and context validation
 * - Function usage limits (e.g., max 1 regex_replace per expression)
 * - Operator type checking (e.g., contains only works on String)
 * - Header key casing warnings
 * - Boolean comparison style hints
 * - Expression length limits
 */

import { parse } from './parser.js';
import { findField, findBaseField, type FieldDef } from './schemas/fields.js';
import { findFunction, type ExpressionContext } from './schemas/functions.js';
import { findComparisonOperator } from './schemas/operators.js';
import type { FieldType } from './schemas/operators.js';
import type {
  ASTNode, Diagnostic, DiagnosticSeverity,
  ValidationContext, LintResult, ExpressionType, OperatorStyle,
} from './types.js';

const MAX_EXPRESSION_LENGTH = 4096;

/**
 * Validate a Cloudflare expression string.
 */
export function validate(expression: string, context: ValidationContext): LintResult {
  const diagnostics: Diagnostic[] = [];

  // Check for leading/trailing whitespace
  if (expression !== expression.trim()) {
    diagnostics.push({
      severity: 'warning',
      message: 'Expression has leading or trailing whitespace which may be unintentional',
      code: 'expression-whitespace',
    });
  }

  // Check expression length
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    diagnostics.push({
      severity: 'warning',
      message: `Expression is ${expression.length} characters, exceeding the ${MAX_EXPRESSION_LENGTH} character limit`,
      code: 'expression-too-long',
    });
  }

  // Check for template placeholders — expressions containing unresolved
  // template variables (e.g., UPPER_CASE_VAR, ${var}, {PLACEHOLDER})
  // cannot be validated since they're not complete expressions yet.
  if (context.allowPlaceholders !== false && containsTemplatePlaceholders(expression)) {
    diagnostics.push({
      severity: 'info',
      message: 'Expression contains template placeholders and cannot be fully validated',
      code: 'contains-placeholders',
    });
    // Still try to parse — some expressions are partially valid
  }

  // Try to parse
  let ast: ASTNode | undefined;
  try {
    ast = parse(expression);
  } catch (err) {
    // If the expression has template placeholders, demote parse errors to warnings
    if (containsTemplatePlaceholders(expression)) {
      diagnostics.push({
        severity: 'warning',
        message: `Parse error (may be caused by template placeholders): ${err instanceof Error ? err.message : String(err)}`,
        code: 'parse-error-placeholder',
      });
      return { expression, valid: true, diagnostics };
    }
    diagnostics.push({
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
      code: 'parse-error',
    });
    return { expression, valid: false, diagnostics };
  }

  // Walk the AST and collect diagnostics
  const walker = new ASTWalker(context, diagnostics);
  walker.walk(ast);

  // Check function usage limits and regex count
  walker.checkFunctionLimits();
  walker.checkRegexCount();

  // Check account-level zone plan suffix
  if (context.accountLevel) {
    checkAccountLevelSuffix(ast, diagnostics);
  }

  // Check for ambiguous operator precedence (and/or mixed without grouping)
  if (context.expressionType === 'filter') {
    checkAmbiguousPrecedence(ast, diagnostics);
  }

  // Check operator style (configurable: 'english', 'clike', or 'off')
  const operatorStyle = context.operatorStyle ?? 'english';
  if (operatorStyle !== 'off') {
    checkOperatorStyle(ast, diagnostics, operatorStyle);
  }

  // Check Expression Builder compatibility for simple expressions
  if (context.expressionType === 'filter') {
    if (context.accountLevel && isZonePlanSuffixed(ast) && ast.kind === 'Logical') {
      // For account-level, check only the filter part (left of the ENT suffix)
      checkBuilderCompatibility(ast.left, diagnostics);
    } else if (!context.accountLevel) {
      checkBuilderCompatibility(ast, diagnostics);
    }
  }

  const hasErrors = diagnostics.some(d => d.severity === 'error');
  return { expression, valid: !hasErrors, diagnostics, ast };
}

class ASTWalker {
  private context: ValidationContext;
  private diagnostics: Diagnostic[];
  private functionCounts: Map<string, number> = new Map();
  private regexCount: number = 0;

  constructor(context: ValidationContext, diagnostics: Diagnostic[]) {
    this.context = context;
    this.diagnostics = diagnostics;
  }

  walk(node: ASTNode): void {
    switch (node.kind) {
      case 'FieldAccess':
        this.validateField(node.field, node.position);
        this.validateHeaderKeyCasing(node);
        break;

      case 'FunctionCall':
        this.validateFunction(node.name, node.position);
        this.functionCounts.set(node.name, (this.functionCounts.get(node.name) ?? 0) + 1);
        for (const arg of node.args) {
          this.walk(arg);
        }
        break;

      case 'Comparison':
        this.walk(node.left);
        this.walk(node.right);
        this.validateOperatorTypes(node);
        this.validateBooleanStyle(node);
        this.validateWildcardPattern(node);
        this.countRegexUsage(node);
        break;

      case 'Logical':
        this.walk(node.left);
        this.walk(node.right);
        break;

      case 'Not':
        this.walk(node.operand);
        break;

      case 'InExpression':
        this.walk(node.field);
        for (const val of node.values) {
          this.walk(val);
        }
        this.validateInExpressionTypes(node);
        this.validateEmptyInList(node);
        break;

      case 'Group':
        this.walk(node.expression);
        break;

      case 'ArrayUnpack':
        this.walk(node.field);
        break;

      case 'NamedList':
        this.validateNamedList(node.name, node.position);
        break;

      case 'BooleanLiteral':
      case 'StringLiteral':
      case 'IntegerLiteral':
      case 'FloatLiteral':
        break;

      case 'IPLiteral':
        if (node.cidr !== undefined) {
          this.validateCIDRMask(node.value, node.cidr, node.position);
        }
        break;
    }
  }

  // ── Field Validation ───────────────────────────────────────────────

  private validateField(fieldName: string, position?: number): void {
    const field = findField(fieldName);

    if (field) {
      if (field.deprecated) {
        this.diagnostics.push({
          severity: 'warning',
          message: `Field "${fieldName}" is deprecated${field.replacement ? `. Use "${field.replacement}" instead` : ''}`,
          code: 'deprecated-field',
          position,
        });
      }

      if (this.context.phase && field.phases && field.phases.length > 0) {
        if (!field.phases.includes(this.context.phase)) {
          this.diagnostics.push({
            severity: 'error',
            message: `Field "${fieldName}" is not available in phase "${this.context.phase}". Available in: ${field.phases.join(', ')}`,
            code: 'field-not-in-phase',
            position,
          });
        }
      }
      return;
    }

    const baseField = findBaseField(fieldName);
    if (baseField) {
      if (baseField.deprecated) {
        this.diagnostics.push({
          severity: 'warning',
          message: `Field "${baseField.name}" is deprecated${baseField.replacement ? `. Use "${baseField.replacement}" instead` : ''}`,
          code: 'deprecated-field',
          position,
        });
      }
      return;
    }

    this.diagnostics.push({
      severity: 'error',
      message: `Unknown field "${fieldName}"`,
      code: 'unknown-field',
      position,
    });
  }

  // ── Header Key Casing ──────────────────────────────────────────────

  private validateHeaderKeyCasing(node: ASTNode): void {
    if (node.kind !== 'FieldAccess') return;
    if (!node.mapKey) return;

    // Only check http.request.headers and http.response.headers
    const isHeaderField = node.field === 'http.request.headers' ||
      node.field === 'http.response.headers' ||
      node.field === 'raw.http.request.headers' ||
      node.field === 'raw.http.response.headers';

    if (isHeaderField && node.mapKey !== node.mapKey.toLowerCase()) {
      this.diagnostics.push({
        severity: 'warning',
        message: `Header key "${node.mapKey}" should be lowercase. Cloudflare normalizes header names to lowercase, so "${node.mapKey}" will never match. Use "${node.mapKey.toLowerCase()}" instead.`,
        code: 'header-key-not-lowercase',
        position: node.position,
      });
    }
  }

  // ── Operator Type Checking ─────────────────────────────────────────

  private validateOperatorTypes(node: ASTNode): void {
    if (node.kind !== 'Comparison') return;

    const operator = node.operator;
    const opDef = findComparisonOperator(operator);
    if (!opDef) return; // Unknown operator — skip type check

    // Resolve the field type from the left-hand side
    const fieldType = this.resolveFieldType(node.left);
    if (!fieldType) return; // Can't determine type (e.g., function call) — skip

    // Check if the operator supports this field type
    if (!opDef.supportedTypes.includes(fieldType)) {
      this.diagnostics.push({
        severity: 'error',
        message: `Operator "${opDef.name}" does not support ${fieldType} fields. Supported types: ${opDef.supportedTypes.join(', ')}`,
        code: 'operator-type-mismatch',
        position: node.position,
      });
    }
  }

  // ── Boolean Style Hints ────────────────────────────────────────────

  private validateBooleanStyle(node: ASTNode): void {
    if (node.kind !== 'Comparison') return;

    // Check for pattern: boolean_field == true or boolean_field eq true
    const op = node.operator;
    if (op !== '==' && op !== 'eq') return;

    // RHS must be boolean literal `true`
    if (node.right.kind !== 'BooleanLiteral' || node.right.value !== true) return;

    // LHS must be a field with Boolean type
    const fieldType = this.resolveFieldType(node.left);
    if (fieldType !== 'Boolean') return;

    const fieldName = node.left.kind === 'FieldAccess' ? node.left.field : 'field';
    this.diagnostics.push({
      severity: 'info',
      message: `Prefer bare "${fieldName}" over "${fieldName} ${op} true"`,
      code: 'prefer-bare-boolean',
      position: node.position,
    });
  }

  // ── Resolve Field Type ─────────────────────────────────────────────

  /**
   * Attempt to determine the FieldType of an AST node.
   * Returns undefined if the type cannot be determined.
   */
  private resolveFieldType(node: ASTNode): FieldType | undefined {
    switch (node.kind) {
      case 'FieldAccess': {
        const field = findField(node.field);
        if (field) {
          // If this field has map key or array index access, resolve to element type
          if (node.mapKey !== undefined || node.arrayIndex !== undefined) {
            if (field.type === 'Map') return 'String';
            if (field.type === 'Array') return 'String';
          }
          return field.type;
        }
        const base = findBaseField(node.field);
        if (base) {
          // Map/Array access yields String (the value type)
          if (base.type === 'Map') return 'String';
          if (base.type === 'Array') return 'String';
        }
        return undefined;
      }

      case 'FunctionCall': {
        const func = findFunction(node.name);
        return func?.returnType;
      }

      case 'StringLiteral':
        return 'String';
      case 'IntegerLiteral':
        return 'Integer';
      case 'FloatLiteral':
        return 'Float';
      case 'BooleanLiteral':
        return 'Boolean';
      case 'IPLiteral':
        return 'IP';

      case 'ArrayUnpack':
        // Array unpack produces individual elements — typically String
        return 'String';

      case 'Group':
        return this.resolveFieldType(node.expression);

      default:
        return undefined;
    }
  }

  // ── Wildcard Pattern Validation ─────────────────────────────────────

  private validateWildcardPattern(node: ASTNode): void {
    if (node.kind !== 'Comparison') return;
    if (node.operator !== 'wildcard' && node.operator !== 'strict wildcard') return;

    // Check the RHS for double asterisks
    if (node.right.kind === 'StringLiteral' && node.right.value.includes('**')) {
      this.diagnostics.push({
        severity: 'warning',
        message: `Wildcard pattern contains "**" which is not allowed. Use a single "*" instead.`,
        code: 'invalid-wildcard-pattern',
        position: node.right.position,
      });
    }
  }

  // ── Regex Count ────────────────────────────────────────────────────

  private countRegexUsage(node: ASTNode): void {
    if (node.kind !== 'Comparison') return;
    if (node.operator === 'matches' || node.operator === '~') {
      this.regexCount++;
    }
  }

  checkRegexCount(): void {
    if (this.regexCount > 64) {
      this.diagnostics.push({
        severity: 'warning',
        message: `Expression uses ${this.regexCount} regex patterns, exceeding the limit of 64 per rule`,
        code: 'too-many-regex',
      });
    }
  }

  // ── In-Expression Type Checking ────────────────────────────────────

  private validateInExpressionTypes(node: ASTNode): void {
    if (node.kind !== 'InExpression') return;

    const fieldType = this.resolveFieldType(node.field);
    if (!fieldType) return;

    // `in` supports String, Integer, and IP — not Boolean or Float
    const supportedInTypes: FieldType[] = ['String', 'Integer', 'IP'];
    if (!supportedInTypes.includes(fieldType)) {
      this.diagnostics.push({
        severity: 'error',
        message: `Operator "in" does not support ${fieldType} fields. Supported types: ${supportedInTypes.join(', ')}`,
        code: 'operator-type-mismatch',
        position: node.position,
      });
    }
  }

  // ── Empty In-List ──────────────────────────────────────────────────

  private validateEmptyInList(node: ASTNode): void {
    if (node.kind !== 'InExpression') return;
    if (node.values.length === 0) {
      this.diagnostics.push({
        severity: 'warning',
        message: 'Empty in-list "{}" — this expression will never match',
        code: 'empty-in-list',
        position: node.position,
      });
    }
  }

  // ── Named List Validation ───────────────────────────────────────────

  private validateNamedList(name: string, position?: number): void {
    // Strip the leading $
    const listName = name.startsWith('$') ? name.slice(1) : name;

    // Managed lists use cf.* prefix — these are always valid
    if (listName.startsWith('cf.')) return;

    // Custom list names must be lowercase, numbers, and underscores only
    if (!/^[a-z0-9_]+$/.test(listName)) {
      this.diagnostics.push({
        severity: 'warning',
        message: `Named list "${name}" may be invalid. Custom list names must use only lowercase letters, numbers, and underscores (a-z, 0-9, _)`,
        code: 'invalid-list-name',
        position,
      });
    }
  }

  // ── CIDR Mask Validation ───────────────────────────────────────────

  private validateCIDRMask(ip: string, mask: number, position?: number): void {
    // Determine if IPv4 or IPv6
    const isIPv6 = ip.includes(':');
    const maxMask = isIPv6 ? 128 : 32;

    if (mask < 0 || mask > maxMask) {
      this.diagnostics.push({
        severity: 'error',
        message: `Invalid CIDR mask /${mask} for ${isIPv6 ? 'IPv6' : 'IPv4'} address. Must be 0-${maxMask}`,
        code: 'invalid-cidr-mask',
        position,
      });
    }
  }

  // ── Function Validation ────────────────────────────────────────────

  private validateFunction(funcName: string, position?: number): void {
    const func = findFunction(funcName);

    if (!func) {
      this.diagnostics.push({
        severity: 'error',
        message: `Unknown function "${funcName}"`,
        code: 'unknown-function',
        position,
      });
      return;
    }

    if (!func.contexts.includes('all')) {
      const exprContext = this.mapExpressionTypeToContext(this.context.expressionType);
      if (!func.contexts.includes(exprContext)) {
        this.diagnostics.push({
          severity: 'error',
          message: `Function "${funcName}" is not available in ${this.context.expressionType} expressions. Available in: ${func.contexts.join(', ')}`,
          code: 'function-not-in-context',
          position,
        });
      }
    }
  }

  checkFunctionLimits(): void {
    for (const [funcName, count] of this.functionCounts) {
      const func = findFunction(funcName);
      if (func?.maxPerExpression && count > func.maxPerExpression) {
        this.diagnostics.push({
          severity: 'error',
          message: `Function "${funcName}" can only be used ${func.maxPerExpression} time(s) per expression, but was used ${count} times`,
          code: 'function-max-exceeded',
        });
      }
    }
  }

  private mapExpressionTypeToContext(exprType: ExpressionType): ExpressionContext {
    switch (exprType) {
      case 'filter': return 'filter';
      case 'rewrite_url': return 'rewrite_url';
      case 'rewrite_header': return 'rewrite_header';
      case 'redirect_target': return 'redirect_target';
    }
  }
}

/**
 * Check for C-like operator notation and suggest English notation.
 * The Expression Builder only generates English notation (eq, ne, and, or).
 */
function checkOperatorStyle(ast: ASTNode, diagnostics: Diagnostic[], style: 'english' | 'clike'): void {
  walkForOperatorStyle(ast, diagnostics, new Set(), style);
}

const CLIKE_TO_ENGLISH: Record<string, string> = {
  '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge',
  '~': 'matches', '&&': 'and', '||': 'or', '!': 'not', '^^': 'xor',
};

const ENGLISH_TO_CLIKE: Record<string, string> = {
  'eq': '==', 'ne': '!=', 'lt': '<', 'le': '<=', 'gt': '>', 'ge': '>=',
  'matches': '~', 'and': '&&', 'or': '||', 'not': '!', 'xor': '^^',
};

function walkForOperatorStyle(
  node: ASTNode, diagnostics: Diagnostic[], reported: Set<string>, style: 'english' | 'clike',
): void {
  if (node.kind === 'Comparison' || node.kind === 'Logical') {
    const flagMap = style === 'english' ? CLIKE_TO_ENGLISH : ENGLISH_TO_CLIKE;
    const code = style === 'english' ? 'prefer-english-operator' : 'prefer-clike-operator';
    const preferred = flagMap[node.operator];
    if (preferred && !reported.has(node.operator)) {
      reported.add(node.operator);
      const label = style === 'english' ? 'English' : 'C-like';
      diagnostics.push({
        severity: 'info',
        message: `Use ${label} notation "${preferred}" instead of "${node.operator}"`,
        code,
        position: node.position,
      });
    }
    if ('left' in node) walkForOperatorStyle(node.left, diagnostics, reported, style);
    if ('right' in node) walkForOperatorStyle(node.right, diagnostics, reported, style);
  } else if (node.kind === 'Group') {
    walkForOperatorStyle(node.expression, diagnostics, reported, style);
  } else if (node.kind === 'Not') {
    walkForOperatorStyle(node.operand, diagnostics, reported, style);
  } else if (node.kind === 'InExpression') {
    walkForOperatorStyle(node.field, diagnostics, reported, style);
  } else if (node.kind === 'FunctionCall') {
    for (const arg of node.args) walkForOperatorStyle(arg, diagnostics, reported, style);
  }
}

/**
 * Check for ambiguous operator precedence — mixing `and` and `or` without
 * explicit grouping. Due to precedence, `A and B or C` evaluates as
 * `(A and B) or C`, not `A and (B or C)`. This is almost always unintentional.
 */
function checkAmbiguousPrecedence(ast: ASTNode, diagnostics: Diagnostic[]): void {
  walkForAmbiguousPrecedence(ast, diagnostics);
}

function walkForAmbiguousPrecedence(node: ASTNode, diagnostics: Diagnostic[]): void {
  if (node.kind !== 'Logical') return;

  const op = node.operator === '||' ? 'or' : node.operator === '&&' ? 'and' : node.operator;

  // Check if an `or` node has an unwrapped `and` as a direct child
  if (op === 'or') {
    if (isUnwrappedAnd(node.left)) {
      diagnostics.push({
        severity: 'warning',
        message: 'Ambiguous operator precedence: `and` combined with `or` without explicit grouping. ' +
          'Due to precedence, `A and B or C` evaluates as `(A and B) or C`. ' +
          'Add explicit parentheses to clarify intent.',
        code: 'ambiguous-precedence',
        position: node.position,
      });
      return; // One warning per expression is enough
    }
    if (isUnwrappedAnd(node.right)) {
      diagnostics.push({
        severity: 'warning',
        message: 'Ambiguous operator precedence: `and` combined with `or` without explicit grouping. ' +
          'Due to precedence, `A or B and C` evaluates as `A or (B and C)`. ' +
          'Add explicit parentheses to clarify intent.',
        code: 'ambiguous-precedence',
        position: node.position,
      });
      return;
    }
  }

  // Recurse into children (but not into Groups — those have explicit precedence)
  if (node.left.kind === 'Logical') walkForAmbiguousPrecedence(node.left, diagnostics);
  if (node.right.kind === 'Logical') walkForAmbiguousPrecedence(node.right, diagnostics);
}

/** Check if a node is an `and` chain that isn't wrapped in a Group */
function isUnwrappedAnd(node: ASTNode): boolean {
  if (node.kind === 'Group') return false; // explicitly grouped — fine
  if (node.kind === 'Logical' && (node.operator === 'and' || node.operator === '&&')) return true;
  return false;
}

/**
 * Check if an expression is formatted for Cloudflare Expression Builder
 * compatibility.
 *
 * The Builder format is:
 *   - Single comparison or all-and: `(A and B and C)` — one wrapping group
 *   - Or-branches: `(A and B) or (C and D) or (E)` — each or-branch wrapped
 *   - Single comparison: `(A)` — wrapped
 *
 * Only flags expressions that ARE simple enough for the Builder but aren't
 * formatted correctly. Complex expressions (functions, xor, nested
 * or-inside-and) are silently skipped. `not` is Builder-compatible.
 */
function checkBuilderCompatibility(ast: ASTNode, diagnostics: Diagnostic[]): void {
  // Bare boolean literals — fine
  if (ast.kind === 'BooleanLiteral') return;

  // Bare boolean field — fine
  if (ast.kind === 'FieldAccess') return;

  // Single unwrapped comparison — needs (field op value)
  if (ast.kind === 'Comparison') {
    if (ast.left.kind === 'FunctionCall' || ast.left.kind === 'ArrayUnpack') return;
    diagnostics.push({
      severity: 'info',
      message: 'Wrap in parentheses for Expression Builder compatibility: (field op value)',
      code: 'builder-incompatible',
    });
    return;
  }

  // Single unwrapped in-expression — needs (field in {...})
  if (ast.kind === 'InExpression') {
    // Negated or function-call field — not Builder-compatible
    if (ast.negated) return;
    if (ast.field.kind === 'FunctionCall' || ast.field.kind === 'ArrayUnpack') return;
    diagnostics.push({
      severity: 'info',
      message: 'Wrap in parentheses for Expression Builder compatibility: (field in {...})',
      code: 'builder-incompatible',
    });
    return;
  }

  // Group — check what's inside
  if (ast.kind === 'Group') {
    const inner = ast.expression;
    // (comparison) or (in-expression) — already good
    if (inner.kind === 'Comparison' || inner.kind === 'InExpression') return;
    // (A and B and C) — all-and inside one group, already good
    if (inner.kind === 'Logical' && isAllAnd(inner) && isSimpleChain(inner)) return;
    // (or-chain inside group) — the outer group must be REMOVED for Builder compat
    // Builder format is (A) or (B), NOT ((A) or (B))
    if (inner.kind === 'Logical' && isAllOr(inner)) {
      diagnostics.push({
        severity: 'info',
        message: 'Remove outer parentheses from or-chain for Expression Builder compatibility. Use (A) or (B) instead of ((A) or (B)).',
        code: 'builder-incompatible',
      });
      return;
    }
    // Other logical inside group — check recursively
    if (inner.kind === 'Logical') {
      checkBuilderCompatibility(inner, diagnostics);
      return;
    }
    // Boolean field etc in group — fine
    if (inner.kind === 'BooleanLiteral' || inner.kind === 'FieldAccess') return;
    return;
  }

  // Logical chain at top level
  if (ast.kind === 'Logical') {
    // Collect top-level or-branches
    const orBranches: ASTNode[] = [];
    if (isAllOr(ast)) {
      collectOrBranches(ast, orBranches);
    } else if (isAllAnd(ast)) {
      // All-and at top level — should be wrapped in one group: (A and B and C)
      if (!isSimpleChain(ast)) return; // complex contents, skip
      diagnostics.push({
        severity: 'info',
        message: 'Wrap and-chain in parentheses for Expression Builder compatibility: (A and B and C)',
        code: 'builder-incompatible',
      });
      return;
    } else {
      // Mixed operators or xor — too complex, skip
      return;
    }

    // Check each or-branch is a wrapped group
    const unwrapped: ASTNode[] = [];
    for (const branch of orBranches) {
      // Each branch should be a Group
      if (branch.kind === 'Group') {
        const inner = branch.expression;
        // Inside should be simple: comparison, in-expression, or all-and chain
        if (inner.kind === 'Comparison' || inner.kind === 'InExpression') continue;
        if (inner.kind === 'Logical' && isAllAnd(inner) && isSimpleChain(inner)) continue;
        if (inner.kind === 'FieldAccess') continue;
        // Complex group contents — skip entire check
        return;
      }
      // Not a group — check if it's simple enough to be Builder-compatible
      if (branch.kind === 'Comparison' || branch.kind === 'InExpression' || branch.kind === 'FieldAccess') {
        unwrapped.push(branch);
        continue;
      }
      if (branch.kind === 'Logical' && isAllAnd(branch) && isSimpleChain(branch)) {
        unwrapped.push(branch);
        continue;
      }
      // Complex branch — skip entire check
      return;
    }

    if (unwrapped.length > 0) {
      diagnostics.push({
        severity: 'info',
        message: `Wrap each or-branch in parentheses for Expression Builder compatibility. ${unwrapped.length} of ${orBranches.length} branch(es) need wrapping.`,
        code: 'builder-incompatible',
      });
    }
    return;
  }

  // Top-level Not wrapping a simple expression — needs wrapping: (not field op value)
  if (ast.kind === 'Not' && isSimpleChain(ast)) {
    diagnostics.push({
      severity: 'info',
      message: 'Wrap in parentheses for Expression Builder compatibility: (not field op value)',
      code: 'builder-incompatible',
    });
    return;
  }

  // Everything else (FunctionCall, etc.) — not Builder-compatible, skip
}

/** Check if a logical chain uses only `and`/`&&` */
function isAllAnd(node: ASTNode): boolean {
  if (node.kind !== 'Logical') return true;
  const op = node.operator;
  if (op !== 'and' && op !== '&&') return false;
  return isAllAnd(node.left) && isAllAnd(node.right);
}

/** Check if the top-level logical chain uses only `or`/`||` (doesn't recurse into branches) */
function isAllOr(node: ASTNode): boolean {
  if (node.kind !== 'Logical') return true;
  const op = node.operator;
  if (op !== 'or' && op !== '||') return false;
  // Only recurse into the or-chain structure, not into and-branches
  const leftIsOr = node.left.kind !== 'Logical' || node.left.operator === 'or' || node.left.operator === '||';
  if (node.left.kind === 'Logical' && (node.left.operator === 'or' || node.left.operator === '||')) {
    return isAllOr(node.left);
  }
  return true; // left is a leaf or and-branch (both fine as or-branch content)
}

/** Check if a logical chain contains only simple leaves (no functions, nested groups)
 *  `not` is allowed on individual comparisons (Builder supports it as a toggle) */
function isSimpleChain(node: ASTNode): boolean {
  if (node.kind === 'Logical') {
    return isSimpleChain(node.left) && isSimpleChain(node.right);
  }
  if (node.kind === 'Comparison') {
    return node.left.kind !== 'FunctionCall' && node.left.kind !== 'ArrayUnpack';
  }
  if (node.kind === 'InExpression') {
    // Negated in-expressions are fine if the field is simple
    return node.field.kind !== 'FunctionCall' && node.field.kind !== 'ArrayUnpack';
  }
  if (node.kind === 'Not') {
    // not wrapping a simple comparison or in-expression is Builder-compatible
    return isSimpleChain(node.operand);
  }
  if (node.kind === 'FieldAccess') return true;
  if (node.kind === 'BooleanLiteral') return true;
  if (node.kind === 'Group') return isSimpleChain(node.expression);
  return false;
}

/** Collect top-level or-branches from an all-or chain */
function collectOrBranches(node: ASTNode, branches: ASTNode[]): void {
  if (node.kind === 'Logical' && (node.operator === 'or' || node.operator === '||')) {
    collectOrBranches(node.left, branches);
    collectOrBranches(node.right, branches);
  } else {
    branches.push(node);
  }
}

/**
 * Check if an AST node ends with `and (cf.zone.plan eq "ENT")`.
 */
function isZonePlanSuffixed(ast: ASTNode): boolean {
  if (ast.kind !== 'Logical') return false;
  if (ast.operator !== 'and' && ast.operator !== '&&') return false;

  // The right side should be (cf.zone.plan eq "ENT")
  let right = ast.right;
  if (right.kind === 'Group') right = right.expression;

  if (right.kind !== 'Comparison') return false;
  if (right.left.kind !== 'FieldAccess') return false;
  if (right.left.field !== 'cf.zone.plan') return false;
  if (right.right.kind !== 'StringLiteral') return false;
  if (right.right.value !== 'ENT') return false;

  return true;
}

/**
 * Check that account-level expressions end with `and (cf.zone.plan eq "ENT")`.
 */
function checkAccountLevelSuffix(ast: ASTNode, diagnostics: Diagnostic[]): void {
  // Standalone (cf.zone.plan eq "ENT") is fine — it's a parent ruleset filter
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

/**
 * Detect if an expression contains template placeholders that will be
 * substituted before deployment (e.g., by Terraform templatefile()).
 *
 * Common patterns:
 *   - UPPER_CASE_IDENTIFIERS inside expressions (not quoted)
 *   - ${variable} Terraform interpolation
 *   - {REPLACE_*} custom placeholders
 */
function containsTemplatePlaceholders(expression: string): boolean {
  // Match unquoted UPPER_CASE identifiers that look like template vars
  // We need to check outside of quoted strings
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

    // Check for UPPER_CASE_IDENTIFIER (at least 2 uppercase + underscore, like ROUTER_API_KEYS)
    if (/[A-Z]/.test(ch)) {
      let j = i;
      while (j < expression.length && /[A-Z0-9_]/.test(expression[j])) j++;
      const word = expression.slice(i, j);
      // Must be at least 4 chars, contain an underscore, and be all-caps
      if (word.length >= 4 && word.includes('_') && /^[A-Z][A-Z0-9_]+$/.test(word)) {
        return true;
      }
    }
  }
  return false;
}
