/**
 * Bounded, serializable validation result shared by the graph and level parsers.
 * Keep codes stable: the UI may switch on them, messages are player-facing English.
 */
export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/**
 * Thrown by `parseGraph` / `parseLevel` (and their JSON-text variants) when the
 * input does not satisfy the strict schema. `issues` always contains at least
 * one entry and every entry has a stable `code` plus a human-readable message.
 */
export class DomainValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = 'DomainValidationError';
    this.issues = issues;
  }
}

/** Byte length of a UTF-8 text, used for the 1 MiB import boundary. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

interface SchemaIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Convert structured schema issues (Zod, or any compatible error) into the
 * public `ValidationIssue` shape. Path is kept in the message so the UI does
 * not need schema knowledge to explain a rejected import.
 */
export function issuesFromSchemaError(error: {
  readonly issues: readonly SchemaIssueLike[];
}): ValidationIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((part) => String(part)).join('.');
    return {
      code: 'schema',
      message: path.length > 0 ? `${path}: ${issue.message}` : issue.message,
    };
  });
}
