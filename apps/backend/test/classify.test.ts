import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from '../src/agents/classify.js';

test('routes tasks to the right specialist', () => {
  assert.equal(classifyTask('Research competitor pricing').agent, 'research');
  assert.equal(classifyTask('Draft the go-to-market plan').agent, 'marketing');
  assert.equal(classifyTask('Design the launch banner').agent, 'designer');
  assert.equal(classifyTask('Reply to Dana about the budget').agent, 'communication');
  assert.equal(classifyTask('Implement the export endpoint').agent, 'code');
});

test('tasks needing a person are left alone', () => {
  for (const t of ['Call the vendor', 'Pay the invoice', 'Hire a designer', 'Get legal to sign off', 'Visit the client in person']) {
    const c = classifyTask(t);
    assert.equal(c.agent, null, t);
    assert.match(c.reason, /person/, t);
  }
});

test('human-only wins over specialist keywords; unknown work has no agent', () => {
  assert.equal(classifyTask('Call Dana and email the report').agent, null);
  assert.equal(classifyTask('Water the plants').agent, null);
  assert.equal(classifyTask('Water the plants').category, 'general');
});

test('the title outranks the spoken description', () => {
  assert.equal(classifyTask('Design the banner', 'Omar will design the banner and email it to the team').agent, 'designer');
  // with no keyword in the title, the full sentence is used
  assert.equal(classifyTask('Update the pricing page', 'Omar will update the pricing page and email the team').agent, 'communication');
});
