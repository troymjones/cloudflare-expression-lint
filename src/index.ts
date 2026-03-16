/**
 * cloudflare-expression-lint
 *
 * A parser, validator, and linter for Cloudflare Rules Language expressions
 * with phase-aware field and function checking.
 */

export { tokenize } from './lexer.js';
export { parse } from './parser.js';
export { validate } from './validator.js';

// Re-export types
export type {
  Token, TokenType,
  ASTNode, BooleanLiteralNode, StringLiteralNode, IntegerLiteralNode,
  FloatLiteralNode, IPLiteralNode, FieldAccessNode, NamedListNode,
  FunctionCallNode, ComparisonNode, LogicalNode, NotNode,
  InExpressionNode, GroupNode, ArrayUnpackNode,
  Diagnostic, DiagnosticSeverity,
  ValidationContext, ExpressionType, LintResult,
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
