/**
 * Core types for the Cloudflare expression linter.
 */

// ── Token Types ────────────────────────────────────────────────────────

export enum TokenType {
  // Literals
  String = 'String',
  RawString = 'RawString',
  Integer = 'Integer',
  Float = 'Float',
  Boolean = 'Boolean',
  IPAddress = 'IPAddress',

  // Identifiers
  Field = 'Field',
  Function = 'Function',
  NamedList = 'NamedList',        // $list_name

  // Operators
  ComparisonOp = 'ComparisonOp',  // eq, ne, lt, le, gt, ge, ==, !=, <, <=, >, >=, contains, matches, ~, wildcard, in
  LogicalOp = 'LogicalOp',        // and, or, not, xor, &&, ||, !, ^^
  StrictWildcard = 'StrictWildcard', // "strict wildcard" (two-word operator)

  // Grouping & Punctuation
  LeftParen = 'LeftParen',
  RightParen = 'RightParen',
  LeftBrace = 'LeftBrace',        // { for in-lists
  RightBrace = 'RightBrace',      // }
  LeftBracket = 'LeftBracket',    // [ for map/array access
  RightBracket = 'RightBracket',  // ]
  Comma = 'Comma',
  DotDot = 'DotDot',             // .. for ranges
  Slash = 'Slash',                // / for CIDR notation

  // Special
  ArrayUnpack = 'ArrayUnpack',    // [*]
  Placeholder = 'Placeholder',    // {REPLACE_...} template variables

  // End
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  position: number;
  line: number;
  column: number;
}

// ── AST Node Types ─────────────────────────────────────────────────────

export type ASTNode =
  | BooleanLiteralNode
  | StringLiteralNode
  | IntegerLiteralNode
  | FloatLiteralNode
  | IPLiteralNode
  | FieldAccessNode
  | NamedListNode
  | FunctionCallNode
  | ComparisonNode
  | LogicalNode
  | NotNode
  | InExpressionNode
  | GroupNode
  | ArrayUnpackNode;

export interface BooleanLiteralNode {
  kind: 'BooleanLiteral';
  value: boolean;
  position: number;
}

export interface StringLiteralNode {
  kind: 'StringLiteral';
  value: string;
  position: number;
}

export interface IntegerLiteralNode {
  kind: 'IntegerLiteral';
  value: number;
  position: number;
}

export interface FloatLiteralNode {
  kind: 'FloatLiteral';
  value: number;
  position: number;
}

export interface IPLiteralNode {
  kind: 'IPLiteral';
  value: string;
  cidr?: number;
  position: number;
}

export interface FieldAccessNode {
  kind: 'FieldAccess';
  /** Full field name (e.g., "http.request.uri.path") */
  field: string;
  /** Map key access, if any (e.g., "host" in headers["host"]) */
  mapKey?: string;
  /** Array index access, if any */
  arrayIndex?: number;
  position: number;
}

export interface NamedListNode {
  kind: 'NamedList';
  name: string;
  position: number;
}

export interface FunctionCallNode {
  kind: 'FunctionCall';
  name: string;
  args: ASTNode[];
  position: number;
}

export interface ComparisonNode {
  kind: 'Comparison';
  left: ASTNode;
  operator: string;
  right: ASTNode;
  position: number;
}

export interface LogicalNode {
  kind: 'Logical';
  left: ASTNode;
  operator: string;
  right: ASTNode;
  position: number;
}

export interface NotNode {
  kind: 'Not';
  operand: ASTNode;
  position: number;
}

export interface InExpressionNode {
  kind: 'InExpression';
  field: ASTNode;
  values: ASTNode[];
  negated: boolean;
  position: number;
}

export interface GroupNode {
  kind: 'Group';
  expression: ASTNode;
  position: number;
}

export interface ArrayUnpackNode {
  kind: 'ArrayUnpack';
  field: ASTNode;
  position: number;
}

// ── Diagnostic Types ───────────────────────────────────────────────────

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  position?: number;
  line?: number;
  column?: number;
  /** Error code for programmatic use */
  code: string;
}

// ── Validation Context ─────────────────────────────────────────────────

export type ExpressionType = 'filter' | 'rewrite_url' | 'rewrite_header' | 'redirect_target';

/**
 * Controls operator style checking.
 * - `'english'` — flag C-like operators (==, !=, etc.) and suggest English (eq, ne, etc.)
 * - `'clike'`   — flag English operators and suggest C-like notation
 * - `'off'`     — disable operator style checking entirely
 *
 * Default: `'english'`
 */
export type OperatorStyle = 'english' | 'clike' | 'off';

export interface ValidationContext {
  /** The Cloudflare phase (e.g., "http_request_firewall_custom") */
  phase?: string;
  /** The type of expression being validated */
  expressionType: ExpressionType;
  /** Allow placeholder templates like {REPLACE_ZONE_NAME} */
  allowPlaceholders?: boolean;
  /** If true, this is an account-level expression that must end with
   *  `and (cf.zone.plan eq "ENT")`. */
  accountLevel?: boolean;
  /** Operator style preference. Default: 'english'. */
  operatorStyle?: OperatorStyle;
}

// ── Lint Result ────────────────────────────────────────────────────────

export interface LintResult {
  /** The original expression string */
  expression: string;
  /** Whether the expression is valid (no errors) */
  valid: boolean;
  /** All diagnostics (errors, warnings, info) */
  diagnostics: Diagnostic[];
  /** Parsed AST (if parsing succeeded) */
  ast?: ASTNode;
}
