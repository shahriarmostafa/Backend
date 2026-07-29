const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { assertNoPathConflict } = require("./helpers/fakeMongo");

/**
 * Mongo rejects an update naming the same path under two operators. That is
 * what broke every teacher quality event for months: `updatedAt` sat in both
 * $setOnInsert and $set, so the call threw and three of the four callers
 * swallowed it silently.
 *
 * This scans the source for update documents that combine operators and flags
 * any that share a key, so the mistake cannot come back unnoticed.
 */

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = ["routes", "utils", "middleware"];

/** Returns the source slice from `start` through its balanced closing brace. */
const readBalanced = (source, start, open = "{", close = "}") => {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
};

/** Top-level `$operator: { ... }` blocks inside an update document. */
const extractOperatorBlocks = (updateDoc) => {
  const blocks = {};
  const operatorPattern = /(\$[a-zA-Z]+)\s*:\s*\{/g;
  let match;
  while ((match = operatorPattern.exec(updateDoc)) !== null) {
    const braceStart = updateDoc.indexOf("{", match.index + match[1].length);
    const body = readBalanced(updateDoc, braceStart);
    if (!body) continue;
    // only count operators at the top level of this document
    const before = updateDoc.slice(1, match.index);
    let depth = 0;
    for (const char of before) {
      if (char === "{" || char === "[") depth += 1;
      if (char === "}" || char === "]") depth -= 1;
    }
    if (depth !== 0) continue;
    blocks[match[1]] = body;
  }
  return blocks;
};

/** Top-level keys of an operator block, quoted, bare, or computed. */
const extractKeys = (block) => {
  const inner = block.slice(1, -1);
  const keys = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      current = "";
      continue;
    }
    if (char === ":" && depth === 0) {
      const key = current.trim().replace(/^["'`]|["'`]$/g, "");
      if (key && !key.startsWith("...")) keys.push(key);
      current = "";
      continue;
    }
    current += char;
  }
  return keys;
};

const findConflicts = (source, file) => {
  const conflicts = [];
  const callPattern = /\b(?:updateOne|updateMany|findOneAndUpdate)\s*\(/g;
  let match;
  while ((match = callPattern.exec(source)) !== null) {
    const args = readBalanced(source, match.index + match[0].length - 1, "(", ")");
    if (!args) continue;
    // second argument: skip the filter, then take the next object literal
    const filterStart = args.indexOf("{");
    const filter = filterStart >= 0 ? readBalanced(args, filterStart) : null;
    if (!filter) continue;
    const updateStart = args.indexOf("{", filterStart + filter.length);
    if (updateStart < 0) continue;
    const updateDoc = readBalanced(args, updateStart);
    if (!updateDoc || !updateDoc.includes("$")) continue;

    const blocks = extractOperatorBlocks(updateDoc);
    const names = Object.keys(blocks);
    if (names.length < 2) continue;

    const seen = new Map();
    for (const name of names) {
      for (const key of extractKeys(blocks[name])) {
        if (seen.has(key) && seen.get(key) !== name) {
          const line = source.slice(0, match.index).split("\n").length;
          conflicts.push(`${file}:${line} - '${key}' in both ${seen.get(key)} and ${name}`);
        }
        seen.set(key, name);
      }
    }
  }
  return conflicts;
};

// --- the scanner has to actually work, so prove it on known input ---

test("the scanner detects the historical updatedAt conflict", () => {
  const bad = `
    await events.updateOne(
      { dedupeKey: uniqueKey },
      { $setOnInsert: { teacherId, delta, createdAt, updatedAt: new Date() },
        $set: { updatedAt: new Date() } },
      { upsert: true }
    );
  `;
  const found = findConflicts(bad, "synthetic.js");
  assert.equal(found.length, 1, `expected one conflict, got ${JSON.stringify(found)}`);
  assert.match(found[0], /updatedAt/);
});

test("the scanner accepts the corrected form", () => {
  const good = `
    await events.updateOne(
      { dedupeKey: uniqueKey },
      { $setOnInsert: { teacherId, delta, createdAt },
        $set: { updatedAt: new Date() } },
      { upsert: true }
    );
  `;
  assert.deepEqual(findConflicts(good, "synthetic.js"), []);
});

test("the scanner does not flag distinct paths or a single operator", () => {
  const fine = `
    await snapshots.updateOne({ uid }, { $set: doc, $setOnInsert: { createdAt: now } }, { upsert: true });
    await users.updateOne({ uid }, { $inc: { credit: 5 } });
    await users.updateOne({ uid }, { $set: { points }, $inc: { rating: delta } });
  `;
  assert.deepEqual(findConflicts(fine, "synthetic.js"), []);
});

// --- and then run it across the real source ---

const collectFiles = (dir) => {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dir, name));
};

test("no update in the codebase puts one path under two operators", () => {
  const files = SCAN_DIRS.flatMap(collectFiles);
  assert.ok(files.length > 0, "scanner found no source files to check");

  const conflicts = files.flatMap((file) =>
    findConflicts(fs.readFileSync(path.join(ROOT, file), "utf8"), file)
  );

  assert.deepEqual(
    conflicts,
    [],
    `Mongo will reject these updates at runtime:\n  ${conflicts.join("\n  ")}`
  );
});

test("the fake collection enforces the same rule the server does", () => {
  assert.throws(
    () => assertNoPathConflict({ $set: { a: 1 }, $setOnInsert: { a: 2 } }),
    /would create a conflict/
  );
  assert.doesNotThrow(() => assertNoPathConflict({ $set: { a: 1 }, $setOnInsert: { b: 2 } }));
});
