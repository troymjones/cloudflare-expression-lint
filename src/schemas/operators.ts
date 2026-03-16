/**
 * Cloudflare expression operators.
 *
 * Reference: https://developers.cloudflare.com/ruleset-engine/rules-language/operators/
 */

export type FieldType = 'String' | 'Integer' | 'Boolean' | 'IP' | 'Bytes' | 'Float' | 'Array' | 'Map';

export interface OperatorDef {
  /** The canonical name (english notation) */
  name: string;
  /** Symbol aliases (C-like notation) */
  symbols: string[];
  /** Which field types this operator supports */
  supportedTypes: FieldType[];
  /** Whether this is a logical operator */
  isLogical?: boolean;
  /** Operator precedence (lower = binds tighter). Only for logical operators. */
  precedence?: number;
}

/** Comparison operators */
export const COMPARISON_OPERATORS: OperatorDef[] = [
  { name: 'eq', symbols: ['=='], supportedTypes: ['String', 'Integer', 'IP', 'Float', 'Boolean'] },
  { name: 'ne', symbols: ['!='], supportedTypes: ['String', 'Integer', 'IP', 'Float', 'Boolean'] },
  { name: 'lt', symbols: ['<'], supportedTypes: ['String', 'Integer', 'Float'] },
  { name: 'le', symbols: ['<='], supportedTypes: ['String', 'Integer', 'Float'] },
  { name: 'gt', symbols: ['>'], supportedTypes: ['String', 'Integer', 'Float'] },
  { name: 'ge', symbols: ['>='], supportedTypes: ['String', 'Integer', 'Float'] },
  { name: 'contains', symbols: [], supportedTypes: ['String'] },
  { name: 'wildcard', symbols: [], supportedTypes: ['String'] },
  { name: 'strict wildcard', symbols: [], supportedTypes: ['String'] },
  { name: 'matches', symbols: ['~'], supportedTypes: ['String'] },
  { name: 'in', symbols: [], supportedTypes: ['String', 'Integer', 'IP'] },
];

/** Logical operators with precedence */
export const LOGICAL_OPERATORS: OperatorDef[] = [
  { name: 'not', symbols: ['!'], supportedTypes: [], isLogical: true, precedence: 1 },
  { name: 'and', symbols: ['&&'], supportedTypes: [], isLogical: true, precedence: 2 },
  { name: 'xor', symbols: ['^^'], supportedTypes: [], isLogical: true, precedence: 3 },
  { name: 'or', symbols: ['||'], supportedTypes: [], isLogical: true, precedence: 4 },
];

/** All operator names and symbols for quick lookup */
export const ALL_COMPARISON_NAMES = new Set(
  COMPARISON_OPERATORS.flatMap(op => [op.name, ...op.symbols])
);

export const ALL_LOGICAL_NAMES = new Set(
  LOGICAL_OPERATORS.flatMap(op => [op.name, ...op.symbols])
);

/** Look up operator def by name or symbol */
export function findComparisonOperator(nameOrSymbol: string): OperatorDef | undefined {
  return COMPARISON_OPERATORS.find(
    op => op.name === nameOrSymbol || op.symbols.includes(nameOrSymbol)
  );
}

export function findLogicalOperator(nameOrSymbol: string): OperatorDef | undefined {
  return LOGICAL_OPERATORS.find(
    op => op.name === nameOrSymbol || op.symbols.includes(nameOrSymbol)
  );
}
