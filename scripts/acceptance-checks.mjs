export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractPassed(value, depth = 0) {
  if (!isRecord(value) || depth > 3) {
    return undefined;
  }
  if (typeof value.passed === 'boolean') {
    return value.passed;
  }
  for (const key of ['result', 'evaluation', 'outcome']) {
    const nested = value[key];
    if (isRecord(nested) && typeof nested.passed === 'boolean') {
      return nested.passed;
    }
  }
  for (const nested of Object.values(value)) {
    if (
      isRecord(nested) &&
      typeof nested.passed === 'boolean' &&
      ('checks' in nested || 'status' in nested || 'scenarios' in nested)
    ) {
      return nested.passed;
    }
  }
  return undefined;
}

/**
 * Try one candidate object as the graph schema for a level.
 *
 * The acceptance harness must not accept a placeholder such as
 * `{ "type": "object" }` or a level descriptor with an unrelated `properties`
 * member. A real graph envelope is an object schema whose required members are
 * `nodes` and `edges`, each an array of objects. Every supported graph contract
 * requires a literal `levelId` bound to the requested level.
 */
export function graphSchemaProblem(value, levelId) {
  if (!isRecord(value)) {
    return 'not a JSON object';
  }
  if (value.type !== 'object') {
    return `type is ${JSON.stringify(value.type)}, expected "object"`;
  }
  if (!isRecord(value.properties)) {
    return 'missing properties object';
  }
  const required = Array.isArray(value.required) ? value.required : [];
  for (const key of ['nodes', 'edges']) {
    if (!required.includes(key)) {
      return `required does not include "${key}"`;
    }
    const collection = value.properties[key];
    if (!isRecord(collection)) {
      return `properties.${key} is missing`;
    }
    if (collection.type !== 'array') {
      return `properties.${key}.type is not "array"`;
    }
    const items = collection.items;
    if (!isObjectItemSchema(items, value)) {
      return `properties.${key}.items does not describe graph items`;
    }
  }
  const level = value.properties.levelId;
  if (!required.includes('levelId') || !isRecord(level) || level.const !== levelId) {
    return `missing required levelId const "${levelId}"`;
  }
  return null;
}

function isObjectItemSchema(items, root, seen = new Set(), inheritedObject = false) {
  if (!isRecord(items) || seen.has(items)) {
    return false;
  }
  const visited = new Set(seen).add(items);
  if (items.type !== undefined && items.type !== 'object') return false;
  // Composition refines its enclosing schema. Parcel's object items use
  // allOf with if/then config constraints that do not repeat type:object.
  const objectBound = inheritedObject || items.type === 'object';
  if (items.$ref !== undefined) {
    if (typeof items.$ref !== 'string' || !items.$ref.startsWith('#/')) return false;
    let target = root;
    for (const part of items.$ref.slice(2).split('/')) {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!isRecord(target) || !Object.hasOwn(target, key)) return false;
      target = target[key];
    }
    if (!isObjectItemSchema(target, root, visited, objectBound)) return false;
  }
  let hasBranches = false;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (items[key] !== undefined) {
      if (!Array.isArray(items[key]) || items[key].length === 0 ||
        !items[key].every((branch) => isObjectItemSchema(branch, root, visited, objectBound))) return false;
      hasBranches = true;
    }
  }
  return objectBound || items.$ref !== undefined || hasBranches;
}

/** Locate a valid graph schema inside a CLI/API discovery payload. */
export function findGraphSchema(value, levelId, depth = 0) {
  if (!isRecord(value) || depth > 4) {
    return null;
  }
  if (graphSchemaProblem(value, levelId) === null) {
    return value;
  }
  if (isRecord(value.graph)) {
    const nested = findGraphSchema(value.graph, levelId, depth + 1);
    if (nested !== null) {
      return nested;
    }
  }
  if (isRecord(value.schemas)) {
    const direct = findGraphSchema(value.schemas[levelId], levelId, depth + 1);
    if (direct !== null) {
      return direct;
    }
    for (const nested of Object.values(value.schemas)) {
      const found = findGraphSchema(nested, levelId, depth + 1);
      if (found !== null) {
        return found;
      }
    }
  }
  for (const key of ['schema', 'result']) {
    if (isRecord(value[key])) {
      const nested = findGraphSchema(value[key], levelId, depth + 1);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

export function failureSignals(value, signals = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      failureSignals(item, signals);
    }
    return signals;
  }
  if (!isRecord(value)) {
    return signals;
  }
  if (value.passed === false) {
    for (const key of ['id', 'code', 'label', 'message', 'metric', 'scenario']) {
      if (typeof value[key] === 'string') {
        signals.push(value[key]);
      }
    }
  }
  if (isRecord(value.error) && typeof value.error.code === 'string') {
    signals.push(value.error.code);
  }
  if (Array.isArray(value.failedChecks)) {
    for (const item of value.failedChecks) {
      if (typeof item === 'string') {
        signals.push(item);
      }
    }
  }
  if (Array.isArray(value.diagnostics)) {
    for (const item of value.diagnostics) {
      if (isRecord(item) && (item.severity === 'error' || item.severity === 'warning')) {
        if (typeof item.code === 'string') signals.push(item.code);
        if (typeof item.id === 'string') signals.push(item.id);
      }
    }
  }
  if (Array.isArray(value.issues)) {
    for (const item of value.issues) {
      if (isRecord(item) && item.severity === 'error' && typeof item.code === 'string') {
        signals.push(item.code);
      }
    }
  }
  for (const nested of Object.values(value)) {
    if (isRecord(nested) || Array.isArray(nested)) {
      failureSignals(nested, signals);
    }
  }
  return signals;
}

export function reasonMatches(parsed, pattern) {
  return failureSignals(parsed).some((signal) => pattern.test(signal));
}

const CROSS_LEVEL_SIGNAL =
  /(?:level|schema)[_-]?(?:override|mismatch|reject|unsupported|invalid)|cross[_-]?level/i;

/** A generic completed `passed:false` is not evidence of a cross-level rejection. */
export function isCrossLevelResultRejection(result) {
  if (!isRecord(result) || result.status !== 'invalid' || result.passed !== false) {
    return false;
  }
  return failureSignals(result).some((signal) => CROSS_LEVEL_SIGNAL.test(signal));
}

/** HTTP 422 is the explicit schema/semantic rejection for a valid-but-wrong-level graph. */
export function isCrossLevelHttpRejection(status, body) {
  if (status === 422) {
    return true;
  }
  if (status !== 400 || !isRecord(body) || !isRecord(body.error)) {
    return false;
  }
  const code = body.error.code;
  return typeof code === 'string' && CROSS_LEVEL_SIGNAL.test(code);
}
