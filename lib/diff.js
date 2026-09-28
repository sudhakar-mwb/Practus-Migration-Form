'use strict';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diffValues(source, destination, pathStr, out) {
  const sourceIsArray = Array.isArray(source);
  const destinationIsArray = Array.isArray(destination);

  if (sourceIsArray || destinationIsArray) {
    if (!sourceIsArray || !destinationIsArray) {
      out.push({ path: pathStr, source, destination });
      return;
    }
    if (source.length !== destination.length) {
      out.push({ path: `${pathStr}.length`, source: source.length, destination: destination.length });
    }
    const maxLen = Math.max(source.length, destination.length);
    for (let i = 0; i < maxLen; i += 1) {
      diffValues(source[i], destination[i], `${pathStr}[${i}]`, out);
    }
    return;
  }

  const sourceIsObject = isPlainObject(source);
  const destinationIsObject = isPlainObject(destination);

  if (sourceIsObject || destinationIsObject) {
    if (!sourceIsObject || !destinationIsObject) {
      out.push({ path: pathStr, source, destination });
      return;
    }
    const keys = new Set([...Object.keys(source), ...Object.keys(destination)]);
    for (const key of keys) {
      const childPath = pathStr ? `${pathStr}.${key}` : key;
      diffValues(source[key], destination[key], childPath, out);
    }
    return;
  }

  if (source !== destination) {
    out.push({ path: pathStr, source, destination });
  }
}

/**
 * Recursively compares two normalized form definitions and returns an array
 * of `{ path, source, destination }` records describing every leaf-level
 * difference (added/removed/changed keys, array length/order/content
 * changes, and scalar value changes). Deliberately avoids
 * `JSON.stringify(a) === JSON.stringify(b)` since that treats key order as
 * significant and gives no indication of *what* differs.
 */
function computeDiff(source, destination) {
  const out = [];
  diffValues(source, destination, '', out);
  return out;
}

module.exports = { computeDiff };
