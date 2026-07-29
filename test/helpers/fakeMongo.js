/**
 * A minimal in-memory stand-in for a Mongo collection.
 *
 * Deliberately not a full Mongo implementation - it supports only the operators
 * the money code actually uses. It DOES reproduce the rule that broke chat
 * reactions for months: an update naming the same path in two operators is
 * rejected, exactly as the server would.
 */

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

const getPath = (doc, path) =>
  path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), doc);

const setPath = (doc, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  let node = doc;
  for (const key of keys) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[last] = value;
};

/** Mongo rejects an update where one path appears under two operators. */
const assertNoPathConflict = (update) => {
  const seen = new Map();
  for (const [operator, fields] of Object.entries(update)) {
    if (!operator.startsWith("$")) continue;
    for (const path of Object.keys(fields || {})) {
      if (seen.has(path)) {
        const error = new Error(
          `Updating the path '${path}' would create a conflict at '${path}'`
        );
        error.code = 40;
        throw error;
      }
      seen.set(path, operator);
    }
  }
};

/**
 * ObjectId instances are never `===` even for the same id, and cloning turns
 * them into their hex string, so compare by string form as a fallback.
 */
const sameValue = (actual, expected) => {
  if (actual === expected) return true;
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  if (actual == null || expected == null) return false;
  if (typeof actual === "object" || typeof expected === "object") {
    return String(actual) === String(expected);
  }
  return false;
};

const isOperatorCondition = (condition) =>
  condition !== null &&
  typeof condition === "object" &&
  !Array.isArray(condition) &&
  Object.keys(condition).some((key) => key.startsWith("$"));

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    // logical operators take an array of sub-filters, not a field value
    if (key === "$or") return (condition || []).some((sub) => matches(doc, sub));
    if (key === "$and") return (condition || []).every((sub) => matches(doc, sub));
    if (key === "$nor") return !(condition || []).some((sub) => matches(doc, sub));

    const actual = getPath(doc, key);
    if (isOperatorCondition(condition)) {
      if ("$exists" in condition) return (actual !== undefined) === condition.$exists;
      if ("$ne" in condition) return actual !== condition.$ne;
      if ("$in" in condition) return condition.$in.includes(actual);
      if ("$gt" in condition) return actual > condition.$gt;
      if ("$gte" in condition) return actual >= condition.$gte;
      if ("$lt" in condition) return actual < condition.$lt;
      if ("$lte" in condition) return actual <= condition.$lte;
      return false;
    }
    // Mongo treats a null filter as "null or missing"
    if (condition === null) return actual === null || actual === undefined;
    return sameValue(actual, condition);
  });

const applyUpdate = (doc, update) => {
  assertNoPathConflict(update);
  if (update.$set) {
    for (const [path, value] of Object.entries(update.$set)) setPath(doc, path, value);
  }
  if (update.$inc) {
    for (const [path, delta] of Object.entries(update.$inc)) {
      setPath(doc, path, (Number(getPath(doc, path)) || 0) + Number(delta));
    }
  }
  if (update.$push) {
    for (const [path, value] of Object.entries(update.$push)) {
      const current = getPath(doc, path);
      setPath(doc, path, [...(Array.isArray(current) ? current : []), value]);
    }
  }
  if (update.$unset) {
    for (const path of Object.keys(update.$unset)) setPath(doc, path, undefined);
  }
  return doc;
};

const createCollection = (seed = []) => {
  let docs = seed.map(clone);

  return {
    /** direct access for assertions */
    _all: () => docs.map(clone),
    _raw: () => docs,

    async findOne(filter = {}) {
      const found = docs.find((doc) => matches(doc, filter));
      return found ? clone(found) : null;
    },

    find(filter = {}) {
      let results = docs.filter((doc) => matches(doc, filter));
      const cursor = {
        project: () => cursor,
        sort: () => cursor,
        limit: (n) => {
          results = results.slice(0, n);
          return cursor;
        },
        toArray: async () => results.map(clone),
      };
      return cursor;
    },

    async updateOne(filter = {}, update = {}, options = {}) {
      const target = docs.find((doc) => matches(doc, filter));
      if (target) {
        applyUpdate(target, update);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options.upsert) {
        // seed from the equality parts of the filter, like Mongo does
        const seedDoc = {};
        for (const [key, value] of Object.entries(filter)) {
          if (value === null || typeof value !== "object") setPath(seedDoc, key, value);
        }
        const created = applyUpdate(
          { ...seedDoc, ...clone(update.$setOnInsert || {}) },
          { ...update, $setOnInsert: undefined }
        );
        docs.push(created);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },

    async insertOne(doc) {
      docs.push(clone(doc));
      return { insertedId: doc._id ?? docs.length };
    },

    async deleteOne(filter = {}) {
      const index = docs.findIndex((doc) => matches(doc, filter));
      if (index === -1) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },

    /** supports only the { $match } + { $group: { _id: null, total: { $sum } } } shape */
    aggregate(pipeline = []) {
      return {
        toArray: async () => {
          let working = docs.map(clone);
          for (const stage of pipeline) {
            if (stage.$match) working = working.filter((doc) => matches(doc, stage.$match));
            if (stage.$group) {
              const field = String(stage.$group.total?.$sum || "").replace(/^\$/, "");
              if (!working.length) return [];
              const total = working.reduce((sum, doc) => sum + (Number(getPath(doc, field)) || 0), 0);
              return [{ _id: null, total }];
            }
          }
          return working;
        },
      };
    },
  };
};

const createDb = (collections = {}) => {
  const store = {};
  for (const [name, seed] of Object.entries(collections)) {
    store[name] = createCollection(seed);
  }
  return {
    collection: (name) => {
      if (!store[name]) store[name] = createCollection([]);
      return store[name];
    },
    _collections: store,
  };
};

module.exports = { createCollection, createDb, assertNoPathConflict, matches, applyUpdate };
