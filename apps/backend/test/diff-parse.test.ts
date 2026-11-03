import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '@meetpilot/shared';

const DIFF = `diff --git a/src/add.js b/src/add.js
--- a/src/add.js
+++ b/src/add.js
@@ -1,5 +1,5 @@
 const a = 1;
 function add(x, y) {
-  return x - y;
+  return x + y;
 }
 module.exports = add;
diff --git a/test/add.test.js b/test/add.test.js
new file mode 100644
--- /dev/null
+++ b/test/add.test.js
@@ -0,0 +1,2 @@
+test('adds', () => {});
+// end
\\ No newline at end of file
`;

test('files, status, counts and line numbers', () => {
  const f = parseDiff(DIFF);
  assert.deepEqual(f.map((x) => [x.path, x.status, x.additions, x.deletions]), [['src/add.js', 'modified', 1, 1], ['test/add.test.js', 'added', 2, 0]]);
  const l = f[0].hunks[0].lines;
  assert.deepEqual(l.map((x) => [x.type, x.oldNo, x.newNo]), [['ctx', 1, 1], ['ctx', 2, 2], ['del', 3, null], ['add', null, 3], ['ctx', 4, 4], ['ctx', 5, 5]]);
  assert.equal(l[2].text, '  return x - y;');
});

test('new files number from 1 and the no-newline marker is a note, not a line', () => {
  const lines = parseDiff(DIFF)[1].hunks[0].lines;
  assert.deepEqual(lines.map((x) => x.type), ['add', 'add', 'note']);
  assert.deepEqual(lines.slice(0, 2).map((x) => x.newNo), [1, 2]);
});

test('lines that look like headers inside a hunk are content', () => {
  const f = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- a dash comment\n+++ a plus comment\n');
  assert.deepEqual([f[0].additions, f[0].deletions], [1, 1]);
  assert.equal(f[0].hunks[0].lines[0].text, '-- a dash comment');
});

test('multiple hunks, deleted files, junk and empty input never throw', () => {
  const f = parseDiff('diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n@@ -10 +10 @@\n-z\n+Z\n');
  assert.deepEqual([f[0].status, f[0].deletions, f[0].additions, f[0].hunks.length], ['deleted', 3, 1, 2]);
  for (const junk of ['', 'hello', '@@ nonsense', '\n\n', null as any, undefined as any]) assert.deepEqual(parseDiff(junk), []);
});
