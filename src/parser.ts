/**
 * Parser for Cloudflare expressions.
 *
 * Converts a token stream into an AST using recursive descent parsing.
 * Handles operator precedence for logical operators:
 *   1. not / !   (highest, unary)
 *   2. and / &&
 *   3. xor / ^^
 *   4. or / ||   (lowest)
 */

import { tokenize } from './lexer.js';
import {
  Token, TokenType, ASTNode,
  BooleanLiteralNode, StringLiteralNode, IntegerLiteralNode,
  FloatLiteralNode, IPLiteralNode, FieldAccessNode, NamedListNode,
  FunctionCallNode, ComparisonNode, LogicalNode, NotNode,
  InExpressionNode, GroupNode, ArrayUnpackNode,
} from './types.js';

class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? this.eof();
  }

  private peekType(): TokenType {
    return this.peek().type;
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length) this.pos++;
    return token;
  }

  private expect(type: TokenType, context?: string): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new Error(
        `Expected ${type}${context ? ' ' + context : ''} but got ${token.type} ("${token.value}") at position ${token.position}`
      );
    }
    return this.advance();
  }

  private eof(): Token {
    const last = this.tokens[this.tokens.length - 1];
    return last ?? { type: TokenType.EOF, value: '', position: 0, line: 1, column: 1 };
  }

  private isAtEnd(): boolean {
    return this.peekType() === TokenType.EOF;
  }

  /**
   * Entry point: parse a full expression.
   */
  parse(): ASTNode {
    if (this.isAtEnd()) {
      throw new Error('Empty expression');
    }
    const node = this.parseOr();
    if (!this.isAtEnd()) {
      const token = this.peek();
      throw new Error(
        `Unexpected token "${token.value}" at position ${token.position} after complete expression`
      );
    }
    return node;
  }

  // ── Logical Operators (precedence climbing) ────────────────────────

  /** Lowest precedence: or / || */
  private parseOr(): ASTNode {
    let left = this.parseXor();
    while (this.matchLogical('or', '||')) {
      const op = this.advance();
      const right = this.parseXor();
      left = { kind: 'Logical', left, operator: op.value, right, position: op.position };
    }
    return left;
  }

  /** xor / ^^ */
  private parseXor(): ASTNode {
    let left = this.parseAnd();
    while (this.matchLogical('xor', '^^')) {
      const op = this.advance();
      const right = this.parseAnd();
      left = { kind: 'Logical', left, operator: op.value, right, position: op.position };
    }
    return left;
  }

  /** and / && */
  private parseAnd(): ASTNode {
    let left = this.parseNot();
    while (this.matchLogical('and', '&&')) {
      const op = this.advance();
      const right = this.parseNot();
      left = { kind: 'Logical', left, operator: op.value, right, position: op.position };
    }
    return left;
  }

  /** Unary not / ! */
  private parseNot(): ASTNode {
    if (this.matchLogical('not', '!')) {
      const op = this.advance();

      // Special case: "not FIELD in {LIST}" → InExpression with negated=true
      // We need to look ahead: if next is a comparison-capable thing followed by 'in'
      const saved = this.pos;
      try {
        const operand = this.parsePrimary();
        if (this.peekType() === TokenType.ComparisonOp && this.peek().value === 'in') {
          this.advance(); // consume 'in'
          const values = this.parseInValues();
          return {
            kind: 'InExpression',
            field: operand,
            values,
            negated: true,
            position: op.position,
          } as InExpressionNode;
        }
        // Not a "not X in Y" pattern — restore and parse normally
        this.pos = saved;
      } catch {
        this.pos = saved;
      }

      const operand = this.parseNot(); // right-recursive for chained not
      return { kind: 'Not', operand, position: op.position };
    }
    return this.parseComparison();
  }

  // ── Comparison Expressions ─────────────────────────────────────────

  private parseComparison(): ASTNode {
    const left = this.parsePrimary();

    // Check for comparison operator
    if (this.peekType() === TokenType.ComparisonOp) {
      const op = this.advance();

      // Special case: 'in' operator has special RHS syntax
      if (op.value === 'in') {
        const values = this.parseInValues();
        return {
          kind: 'InExpression',
          field: left,
          values,
          negated: false,
          position: op.position,
        } as InExpressionNode;
      }

      const right = this.parsePrimary();
      return {
        kind: 'Comparison',
        left,
        operator: op.value,
        right,
        position: op.position,
      };
    }

    return left;
  }

  // ── In-List Values ─────────────────────────────────────────────────

  private parseInValues(): ASTNode[] {
    // Can be: { value1 value2 ... } or $named_list
    if (this.peekType() === TokenType.NamedList) {
      const token = this.advance();
      return [{ kind: 'NamedList', name: token.value, position: token.position }];
    }

    this.expect(TokenType.LeftBrace, 'after "in"');
    const values: ASTNode[] = [];

    while (this.peekType() !== TokenType.RightBrace && !this.isAtEnd()) {
      const token = this.peek();

      if (token.type === TokenType.String || token.type === TokenType.RawString) {
        this.advance();
        values.push({ kind: 'StringLiteral', value: token.value, position: token.position });
      } else if (token.type === TokenType.Integer) {
        this.advance();
        // Check for range (..)
        if (this.peekType() === TokenType.DotDot) {
          this.advance(); // consume ..
          const end = this.expect(TokenType.Integer, 'in range');
          values.push({ kind: 'IntegerLiteral', value: parseInt(token.value), position: token.position });
          values.push({ kind: 'IntegerLiteral', value: parseInt(end.value), position: end.position });
        } else {
          values.push({ kind: 'IntegerLiteral', value: parseInt(token.value), position: token.position });
        }
      } else if (token.type === TokenType.IPAddress) {
        this.advance();
        // Check for CIDR /xx
        if (this.peekType() === TokenType.Slash) {
          this.advance(); // consume /
          const bits = this.expect(TokenType.Integer, 'in CIDR');
          values.push({ kind: 'IPLiteral', value: token.value, cidr: parseInt(bits.value), position: token.position });
        } else if (this.peekType() === TokenType.DotDot) {
          // IP range
          this.advance(); // consume ..
          const endIP = this.expect(TokenType.IPAddress, 'in IP range');
          values.push({ kind: 'IPLiteral', value: token.value, position: token.position });
          values.push({ kind: 'IPLiteral', value: endIP.value, position: endIP.position });
        } else {
          values.push({ kind: 'IPLiteral', value: token.value, position: token.position });
        }
      } else {
        throw new Error(
          `Unexpected token "${token.value}" (${token.type}) in in-list at position ${token.position}`
        );
      }
    }

    this.expect(TokenType.RightBrace, 'closing in-list');
    return values;
  }

  // ── Primary Expressions ────────────────────────────────────────────

  private parsePrimary(): ASTNode {
    const token = this.peek();

    switch (token.type) {
      case TokenType.LeftParen:
        return this.parseGroup();

      case TokenType.Boolean:
        this.advance();
        return { kind: 'BooleanLiteral', value: token.value === 'true', position: token.position };

      case TokenType.String:
      case TokenType.RawString:
        this.advance();
        return { kind: 'StringLiteral', value: token.value, position: token.position };

      case TokenType.Integer:
        this.advance();
        return { kind: 'IntegerLiteral', value: parseInt(token.value), position: token.position };

      case TokenType.IPAddress:
        this.advance();
        return { kind: 'IPLiteral', value: token.value, position: token.position };

      case TokenType.NamedList:
        this.advance();
        return { kind: 'NamedList', name: token.value, position: token.position };

      case TokenType.Function:
        return this.parseFunctionCall();

      case TokenType.Field:
        return this.parseFieldAccess();

      default:
        throw new Error(
          `Unexpected token "${token.value}" (${token.type}) at position ${token.position}`
        );
    }
  }

  // ── Grouped Expression ─────────────────────────────────────────────

  private parseGroup(): ASTNode {
    const open = this.expect(TokenType.LeftParen);
    const expr = this.parseOr();
    this.expect(TokenType.RightParen, 'to close group');
    return { kind: 'Group', expression: expr, position: open.position };
  }

  // ── Function Call ──────────────────────────────────────────────────

  private parseFunctionCall(): ASTNode {
    const nameToken = this.expect(TokenType.Function);
    this.expect(TokenType.LeftParen, `after function "${nameToken.value}"`);

    const args: ASTNode[] = [];
    if (this.peekType() !== TokenType.RightParen) {
      args.push(this.parseOr());
      while (this.peekType() === TokenType.Comma) {
        this.advance(); // consume comma
        args.push(this.parseOr());
      }
    }

    this.expect(TokenType.RightParen, `to close function "${nameToken.value}"`);

    let result: ASTNode = {
      kind: 'FunctionCall',
      name: nameToken.value,
      args,
      position: nameToken.position,
    };

    // Handle chained array unpacks and bracket access after function call
    // e.g., lower(http.request.headers.names[*])[*]
    while (this.peekType() === TokenType.ArrayUnpack || this.peekType() === TokenType.LeftBracket) {
      if (this.peekType() === TokenType.ArrayUnpack) {
        const unpack = this.advance();
        result = { kind: 'ArrayUnpack', field: result, position: unpack.position };
      } else {
        // Bracket access after function result - just consume it as part of the expression
        this.advance(); // [
        if (this.peekType() === TokenType.String || this.peekType() === TokenType.RawString || this.peekType() === TokenType.Integer) {
          this.advance(); // key/index
        }
        this.expect(TokenType.RightBracket);
      }
    }

    return result;
  }

  // ── Field Access ───────────────────────────────────────────────────

  private parseFieldAccess(): ASTNode {
    const fieldToken = this.expect(TokenType.Field);
    let field = fieldToken.value;
    let mapKey: string | undefined;
    let arrayIndex: number | undefined;

    // Handle bracket access: field["key"] or field[0]
    while (this.peekType() === TokenType.LeftBracket) {
      this.advance(); // consume [
      const inner = this.peek();
      if (inner.type === TokenType.String || inner.type === TokenType.RawString) {
        mapKey = inner.value;
        this.advance();
      } else if (inner.type === TokenType.Integer) {
        arrayIndex = parseInt(inner.value);
        this.advance();
      }
      this.expect(TokenType.RightBracket);
    }

    // Handle array unpack [*]
    if (this.peekType() === TokenType.ArrayUnpack) {
      const unpack = this.advance();
      const fieldNode: FieldAccessNode = { kind: 'FieldAccess', field, mapKey, position: fieldToken.position };
      return { kind: 'ArrayUnpack', field: fieldNode, position: unpack.position };
    }

    return { kind: 'FieldAccess', field, mapKey, arrayIndex, position: fieldToken.position };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private matchLogical(...values: string[]): boolean {
    const token = this.peek();
    return token.type === TokenType.LogicalOp && values.includes(token.value);
  }
}

/**
 * Parse a Cloudflare expression string into an AST.
 * @throws Error on syntax errors
 */
export function parse(input: string): ASTNode {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  return parser.parse();
}
