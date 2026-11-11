import { LIMITS } from '../contracts.js';

export interface GraphInspectionIssue {
  readonly code: 'graph_too_deep' | 'graph_too_large' | 'graph_unsafe_key';
  readonly message: string;
  readonly path: string;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PATH = 200;

function childPath(parent: string, key: string, array: boolean): string {
  // eslint-disable-next-line no-control-regex -- Keep user-supplied keys safe to display in diagnostics.
  const safeKey = key.replace(/[\u0000-\u001f\u007f]/g, '?');
  const next = array ? `${parent}[${safeKey}]` : `${parent}.${safeKey}`;
  return next.length <= MAX_PATH ? next : `${next.slice(0, MAX_PATH - 3)}...`;
}

/**
 * Cheap transport guard before a graph reaches the engine. The level's own
 * schema remains authoritative for node kinds, routes and semantic rules.
 * Iterative by design so adversarial nesting cannot overflow the call stack.
 */
export function inspectGraph(graph: unknown): GraphInspectionIssue | null {
  const stack: { value: unknown; depth: number; path: string }[] = [
    { value: graph, depth: 0, path: '$' },
  ];
  const seen = new WeakSet<object>();
  let values = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    values += 1;
    if (values > LIMITS.graphValues) {
      return {
        code: 'graph_too_large',
        message: `The graph exceeds ${LIMITS.graphValues} JSON values.`,
        path: frame.path,
      };
    }
    if (frame.depth > LIMITS.graphDepth) {
      return {
        code: 'graph_too_deep',
        message: `The graph exceeds ${LIMITS.graphDepth} levels of nesting.`,
        path: frame.path,
      };
    }
    if (typeof frame.value !== 'object' || frame.value === null) {
      continue;
    }
    if (seen.has(frame.value)) {
      continue;
    }
    seen.add(frame.value);

    if (Array.isArray(frame.value)) {
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: frame.value[index],
          depth: frame.depth + 1,
          path: childPath(frame.path, String(index), true),
        });
      }
      continue;
    }

    const record = frame.value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (UNSAFE_KEYS.has(key)) {
        return {
          code: 'graph_unsafe_key',
          message: 'The graph contains a forbidden object key.',
          path: childPath(frame.path, key, false),
        };
      }
      stack.push({
        value: record[key],
        depth: frame.depth + 1,
        path: childPath(frame.path, key, false),
      });
    }
  }

  return null;
}
