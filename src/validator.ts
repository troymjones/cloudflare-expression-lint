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
import { checkBuilderCompatibility, checkAccountLevelSuffix, isZonePlanSuffixed } from './builder-compat.js';
import { containsTemplatePlaceholders, containsLegacyPlaceholders } from './template-detection.js';
import { substitutePlaceholders } from './placeholders.js';
import { printNode, normalizeOp, collectChain } from './ast-utils.js';
import type {
  ASTNode, Diagnostic, DiagnosticSeverity, FunctionCallNode,
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
  // template variables (e.g., __NAME__, UPPER_CASE_VAR, ${var})
  // cannot be validated since they're not complete expressions yet.
  if (context.allowPlaceholders !== false && containsTemplatePlaceholders(expression)) {
    diagnostics.push({
      severity: 'info',
      message: 'Expression contains template placeholders and cannot be fully validated',
      code: 'contains-placeholders',
    });
    // Warn if using legacy UPPER_CASE format instead of __NAME__
    if (containsLegacyPlaceholders(expression)) {
      diagnostics.push({
        severity: 'info',
        message: 'Use __NAME__ format for placeholders (e.g., __ALLOWED_IPS__ instead of ALLOWED_IPS) for reliable parsing and formatting',
        code: 'legacy-placeholder-format',
      });
    }
    // Still try to parse — some expressions are partially valid
  }

  // Try to parse. If the expression has placeholders, substitute them with
  // synthetic string literals first so the parser can build a complete AST.
  // The same substitution pattern is used by fixer.ts and formatter.ts.
  const hasPlaceholders = context.allowPlaceholders !== false
    && containsTemplatePlaceholders(expression);
  const toParse = hasPlaceholders
    ? substitutePlaceholders(expression).expression
    : expression;

  let ast: ASTNode | undefined;
  try {
    ast = parse(toParse);
  } catch (err) {
    // If substitution didn't help, fall back to the pre-substitution warning path
    if (hasPlaceholders) {
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

  // Check for tautologically-false `and` chains and tautologically-true `or` chains
  checkIllogicalConditions(ast, diagnostics);

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
  /** FunctionCall nodes that a parent ArrayUnpack re-indexes with `[*]`. */
  private unpackedCalls: Set<ASTNode> = new Set();

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
        this.validateArrayMapping(node);
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
        this.validateValueDomain(node);
        break;

      case 'Logical':
        this.walk(node.left);
        this.walk(node.right);
        break;

      case 'Not':
        this.walk(node.operand);
        this.checkNegatedComparison(node);
        break;

      case 'InExpression':
        this.walk(node.field);
        for (const val of node.values) {
          this.walk(val);
        }
        this.validateInExpressionTypes(node);
        this.validateEmptyInList(node);
        this.checkLongInList(node);
        this.validateDuplicateListEntries(node);
        this.validateInListValueDomain(node);
        break;

      case 'Group':
        this.walk(node.expression);
        break;

      case 'ArrayUnpack':
        if (node.field.kind === 'FunctionCall') {
          this.unpackedCalls.add(node.field);
        }
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
          // CF Map fields (e.g. headers, cookies) are Map<String, Array<String>>.
          // `field["key"]` yields Array<String>; a further `[i]` yields String.
          if (field.type === 'Map') {
            if (node.arrayIndex !== undefined) return 'String';
            if (node.mapKey !== undefined) return 'Array';
            return 'Map';
          }
          if (field.type === 'Array') {
            if (node.arrayIndex !== undefined) return 'String';
            return 'Array';
          }
          return field.type;
        }
        const base = findBaseField(node.field);
        if (base) {
          if (base.type === 'Map') {
            if (node.arrayIndex !== undefined) return 'String';
            if (node.mapKey !== undefined) return 'Array';
            return 'Map';
          }
          if (base.type === 'Array') {
            if (node.arrayIndex !== undefined) return 'String';
            return 'Array';
          }
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

  private checkLongInList(node: ASTNode): void {
    if (node.kind !== 'InExpression') return;
    // Only check literal value lists, not named lists ($list_name)
    if (node.values.length === 1 && node.values[0].kind === 'NamedList') return;
    const threshold = this.context.maxInListItems ?? 10;
    if (node.values.length >= threshold) {
      this.diagnostics.push({
        severity: 'info',
        message: `In-list has ${node.values.length} items. Consider using a named list ($list_name) for maintainability.`,
        code: 'long-in-list',
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

  /**
   * A function applied to `field[*]` is mapped over the array, so its result is
   * also an array and needs its own `[*]` before it can be compared. Cloudflare
   * rejects the un-indexed form with "cannot perform this operation on type Array".
   */
  private validateArrayMapping(node: FunctionCallNode): void {
    if (this.unpackedCalls.has(node)) return;

    const func = findFunction(node.name);
    const arrayArg = node.args.findIndex((arg, i) => {
      if (arg.kind !== 'ArrayUnpack') return false;
      // any()/all()/join() consume the array itself rather than mapping over it.
      const params = func?.params ?? [];
      const param = params[Math.min(i, params.length - 1)];
      const variadicTail = param?.variadic && i >= params.length - 1;
      if (param && (param.variadic ? variadicTail : true) && param.type === 'Array') return false;
      return true;
    });
    if (arrayArg === -1) return;

    this.diagnostics.push({
      severity: 'error',
      message: `"${node.name}()" is applied to an array ("[*]"), so it returns an array — add "[*]" after "${node.name}(...)" to map the comparison over each element`,
      code: 'missing-array-unpack',
      position: node.position,
    });
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

  // ── Duplicate List Entries ─────────────────────────────────────────

  private validateDuplicateListEntries(node: ASTNode): void {
    if (node.kind !== 'InExpression') return;
    if (node.values.length < 2) return;

    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    for (const v of node.values) {
      // Skip named-list-as-value (shouldn't mix with literals in practice)
      if (v.kind === 'NamedList') continue;
      const key = printNode(v);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count === 2) duplicates.push(key);
    }
    if (duplicates.length > 0) {
      const shown = duplicates.slice(0, 3).join(', ');
      const more = duplicates.length > 3 ? ` and ${duplicates.length - 3} more` : '';
      this.diagnostics.push({
        severity: 'warning',
        message: `Duplicate value(s) in in-list: ${shown}${more}. Each value only needs to appear once.`,
        code: 'duplicate-list-entries',
        position: node.position,
      });
    }
  }

  // ── Negated Comparison ─────────────────────────────────────────────

  private checkNegatedComparison(node: ASTNode): void {
    if (node.kind !== 'Not') return;
    const inner = node.operand.kind === 'Group' ? node.operand.expression : node.operand;
    if (inner.kind !== 'Comparison') return;
    const op = normalizeComparisonOp(inner.operator);
    if (op !== 'eq' && op !== 'ne') return;
    // Skip function-call LHS (no clean inverse); leave those alone
    if (inner.left.kind === 'FunctionCall' || inner.left.kind === 'ArrayUnpack') return;
    const inverse = op === 'eq' ? 'ne' : 'eq';
    this.diagnostics.push({
      severity: 'info',
      message: `Prefer "${inverse}" over "not ... ${op}": rewrite as \`${printNode(inner.left)} ${inverse} ${printNode(inner.right)}\``,
      code: 'negated-comparison',
      position: node.position,
    });
  }

  // ── Value Domain Checks ─────────────────────────────────────────────

  private validateValueDomain(node: ASTNode): void {
    if (node.kind !== 'Comparison') return;
    const op = normalizeComparisonOp(node.operator);
    if (op !== 'eq' && op !== 'ne') return;
    if (node.left.kind !== 'FieldAccess') return;
    this.checkValueDomainPair(node.left.field, node.right, node.position);
  }

  private validateInListValueDomain(node: ASTNode): void {
    if (node.kind !== 'InExpression') return;
    if (node.field.kind !== 'FieldAccess') return;
    for (const v of node.values) {
      if (v.kind === 'NamedList') continue;
      this.checkValueDomainPair(node.field.field, v, node.position);
    }
  }

  private checkValueDomainPair(fieldName: string, value: ASTNode, position?: number): void {
    if (fieldName === 'http.request.method') {
      if (value.kind === 'StringLiteral' && !/^[A-Z]+$/.test(value.value)) {
        this.diagnostics.push({
          severity: 'warning',
          message: `HTTP method "${value.value}" — Cloudflare normalizes methods to uppercase ASCII letters, so this value will never match.`,
          code: 'value-domain-method',
          position,
        });
      }
      return;
    }

    if (fieldName === 'ip.src.country' || fieldName === 'ip.geoip.country') {
      if (value.kind === 'StringLiteral' && !/^[A-Z]{2}$|^T1$|^XX$/.test(value.value)) {
        this.diagnostics.push({
          severity: 'warning',
          message: `Country "${value.value}" — expected a 2-letter uppercase ISO code (e.g., "US", "DE"). Values are case-sensitive.`,
          code: 'value-domain-country',
          position,
        });
      }
      return;
    }

    if (fieldName === 'ip.src.continent' || fieldName === 'ip.geoip.continent') {
      const valid = new Set(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA', 'T1']);
      if (value.kind === 'StringLiteral' && !valid.has(value.value)) {
        this.diagnostics.push({
          severity: 'warning',
          message: `Continent "${value.value}" — expected one of AF, AN, AS, EU, NA, OC, SA, T1. Values are case-sensitive.`,
          code: 'value-domain-continent',
          position,
        });
      }
      return;
    }

    if (fieldName === 'cf.edge.server_port' || fieldName === 'cf.edge.client_port') {
      if (value.kind === 'IntegerLiteral' && (value.value < 0 || value.value > 65535)) {
        this.diagnostics.push({
          severity: 'warning',
          message: `Port ${value.value} is outside the valid range 0–65535.`,
          code: 'value-domain-port',
          position,
        });
      }
      return;
    }

    if (fieldName === 'http.request.uri.path' || fieldName === 'http.request.uri.path.extension') {
      if (value.kind !== 'StringLiteral') return;
      if (value.raw) return; // raw strings are explicit regex intent; skip
      const v = value.value;

      // Regex-shaped literal: value contains regex metachars meaningful only in `matches`.
      // Catches the class of bug where someone writes `path ne "^/api.*"` thinking `ne`
      // interprets regex (it doesn't — it's literal equality).
      if (/^\^|\.\*|\.\+|\\[dwsDWS]|\$$/.test(v)) {
        this.diagnostics.push({
          severity: 'warning',
          message: `Path "${v}" looks like a regex pattern but is being compared with literal eq/ne. Use \`matches r"..."\` for regex or \`starts_with(path, "/prefix")\` / \`ends_with(path, ".htm")\` for prefix/suffix matches.`,
          code: 'value-domain-path-regex',
          position,
        });
        return;
      }

      // Path comparison with a value that doesn't start with /: will never match
      // since Cloudflare guarantees paths start with /.
      if (fieldName === 'http.request.uri.path' && !v.startsWith('/')) {
        this.diagnostics.push({
          severity: 'warning',
          message: `Path "${v}" does not start with "/". Cloudflare paths always start with "/", so this comparison will never match.`,
          code: 'value-domain-path',
          position,
        });
      }
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
 * Detect tautologically-impossible conditions:
 *   `A eq X and A eq Y`   (X != Y)  — always false
 *   `A ne X or A ne Y`    (X != Y)  — always true
 *
 * Fires once per chain. Only flags direct siblings of the same-operator chain;
 * parenthesized sub-expressions are treated as opaque. Requires literal RHS
 * (string/int/bool) on both sides and identical LHS (compared structurally).
 */
function checkIllogicalConditions(ast: ASTNode, diagnostics: Diagnostic[]): void {
  const reported = new Set<string>();
  walkForIllogical(ast, diagnostics, reported);
}

function walkForIllogical(node: ASTNode, diagnostics: Diagnostic[], reported: Set<string>): void {
  switch (node.kind) {
    case 'Logical': {
      const op = normalizeOp(node.operator);
      if (op === 'and' || op === 'or') {
        checkSameFieldConflicts(node, op, diagnostics, reported);
      }
      walkForIllogical(node.left, diagnostics, reported);
      walkForIllogical(node.right, diagnostics, reported);
      return;
    }
    case 'Group':
      walkForIllogical(node.expression, diagnostics, reported);
      return;
    case 'Not':
      walkForIllogical(node.operand, diagnostics, reported);
      return;
    case 'InExpression':
      walkForIllogical(node.field, diagnostics, reported);
      return;
    case 'FunctionCall':
      for (const arg of node.args) walkForIllogical(arg, diagnostics, reported);
      return;
  }
}

function checkSameFieldConflicts(
  root: ASTNode & { kind: 'Logical' },
  op: 'and' | 'or',
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const branches: ASTNode[] = [];
  collectChain(root, op, branches);

  // Only run this at the ROOT of a same-op chain to avoid double-reporting:
  // if any ancestor of root is also a same-op Logical we'd have already
  // checked it. Since we can't see the parent, we rely on `reported` de-dupe.

  // For `and`, look for duplicate `eq`/`==` on same field with distinct literals
  // For `or`,  look for duplicate `ne`/`!=` on same field with distinct literals
  const targetOp = op === 'and' ? 'eq' : 'ne';
  const bucket = new Map<string, { literal: string; position?: number }[]>();

  for (const b of branches) {
    if (b.kind !== 'Comparison') continue;
    if (normalizeComparisonOp(b.operator) !== targetOp) continue;
    if (b.left.kind === 'FunctionCall' || b.left.kind === 'ArrayUnpack') continue;
    if (!isLiteral(b.right)) continue;
    const leftKey = printNode(b.left);
    const rightKey = printNode(b.right);
    const list = bucket.get(leftKey) ?? [];
    list.push({ literal: rightKey, position: b.position });
    bucket.set(leftKey, list);
  }

  for (const [leftKey, entries] of bucket) {
    const unique = new Set(entries.map(e => e.literal));
    if (unique.size < 2) continue;
    const dedupeKey = `${op}:${leftKey}`;
    if (reported.has(dedupeKey)) continue;
    reported.add(dedupeKey);
    const sample = Array.from(unique).slice(0, 3).join(', ');
    if (op === 'and') {
      diagnostics.push({
        severity: 'warning',
        message: `Illogical \`and\`: "${leftKey}" cannot simultaneously equal multiple different values (${sample}). This condition is always false.`,
        code: 'illogical-condition',
        position: entries[0].position,
      });
    } else {
      diagnostics.push({
        severity: 'warning',
        message: `Illogical \`or\`: "${leftKey} ne ..." for multiple values (${sample}) is always true — any given value is not-equal-to at least one of them. Did you mean \`and\` or \`not in {...}\`?`,
        code: 'illogical-condition',
        position: entries[0].position,
      });
    }
  }
}

/** Normalize comparison operators including C-like forms to English. */
function normalizeComparisonOp(op: string): string {
  switch (op) {
    case '==': return 'eq';
    case '!=': return 'ne';
    case '<':  return 'lt';
    case '<=': return 'le';
    case '>':  return 'gt';
    case '>=': return 'ge';
    case '~':  return 'matches';
    default:   return op;
  }
}

function isLiteral(node: ASTNode): boolean {
  return node.kind === 'StringLiteral'
    || node.kind === 'IntegerLiteral'
    || node.kind === 'FloatLiteral'
    || node.kind === 'BooleanLiteral'
    || node.kind === 'IPLiteral';
}
