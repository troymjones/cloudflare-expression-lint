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
  ValidationContext, LintResult, ExpressionType,
} from './types.js';

const MAX_EXPRESSION_LENGTH = 4096;

/**
 * Validate a Cloudflare expression string.
 */
export function validate(expression: string, context: ValidationContext): LintResult {
  const diagnostics: Diagnostic[] = [];

  // Check expression length
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    diagnostics.push({
      severity: 'warning',
      message: `Expression is ${expression.length} characters, exceeding the ${MAX_EXPRESSION_LENGTH} character limit`,
      code: 'expression-too-long',
    });
  }

  // Try to parse
  let ast: ASTNode | undefined;
  try {
    ast = parse(expression);
  } catch (err) {
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

  // Check function usage limits
  walker.checkFunctionLimits();

  const hasErrors = diagnostics.some(d => d.severity === 'error');
  return { expression, valid: !hasErrors, diagnostics, ast };
}

class ASTWalker {
  private context: ValidationContext;
  private diagnostics: Diagnostic[];
  private functionCounts: Map<string, number> = new Map();

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
        break;

      case 'Group':
        this.walk(node.expression);
        break;

      case 'ArrayUnpack':
        this.walk(node.field);
        break;

      case 'BooleanLiteral':
      case 'StringLiteral':
      case 'IntegerLiteral':
      case 'FloatLiteral':
      case 'IPLiteral':
      case 'NamedList':
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
