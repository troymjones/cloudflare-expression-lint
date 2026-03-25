/**
 * cloudflare-expression-lint
 *
 * A parser, validator, and linter for Cloudflare Rules Language expressions
 * with phase-aware field and function checking.
 */

export { tokenize } from './lexer.js';
export { parse } from './parser.js';
export { printNode, normalizeOp, collectChain, stripGroup } from './ast-utils.js';
export { validate } from './validator.js';
export { formatExpression } from './formatter.js';
export type { FormatOptions } from './formatter.js';
export { fixExpression } from './fixer.js';
export type { FixOptions, FixResult } from './fixer.js';

// Re-export types
export type {
  Token, TokenType,
  ASTNode, BooleanLiteralNode, StringLiteralNode, IntegerLiteralNode,
  FloatLiteralNode, IPLiteralNode, FieldAccessNode, NamedListNode,
  FunctionCallNode, ComparisonNode, LogicalNode, NotNode,
  InExpressionNode, GroupNode, ArrayUnpackNode,
  Diagnostic, DiagnosticSeverity,
  ValidationContext, ExpressionType, OperatorStyle, LintResult,
} from './types.js';

// Re-export schema types for consumers who want to extend
export { FIELDS, findField, findBaseField } from './schemas/fields.js';
export type { FieldDef } from './schemas/fields.js';
export { FUNCTIONS, findFunction } from './schemas/functions.js';
export type { FunctionDef, ExpressionContext } from './schemas/functions.js';
export {
  COMPARISON_OPERATORS, LOGICAL_OPERATORS,
  findComparisonOperator, findLogicalOperator,
} from './schemas/operators.js';
export type { OperatorDef, FieldType } from './schemas/operators.js';

// Re-export YAML scanner
export {
  scanYaml,
  getDefaultExpressionKeys,
  getDefaultPhaseMappings,
} from './yaml-scanner.js';
export type {
  YAMLExpressionLocation,
  YAMLScanResult,
  ExpressionKeyMapping,
  PhaseMapping,
  ScannerOptions,
} from './yaml-scanner.js';

// ESLint plugin adapter
export { default as eslintPlugin } from './eslint-plugin.js';
export {
  plugin as cloudflareExpressionLintPlugin,
  validateExpressionRule,
  createValidateExpressionRule,
  isExpressionKey,
  inferExpressionType,
  inferPhaseFromKey,
  DEFAULT_EXPRESSION_KEYS,
} from './eslint-plugin.js';
export type { ValidateExpressionRuleOptions } from './eslint-plugin.js';
