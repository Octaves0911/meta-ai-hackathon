import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask, MIN_CONFIDENCE } from '../src/agents/router.js';

const model = (o: Partial<any> = {}) => async () => ({
  category: 'research', agent: 'research', stages: [{ agent: 'research', goal: 'g' }], scope: 'deliverable', can_ai_do: true, confidence: 0.9,
  reason: 'looks like research', human_reason: '', missing_inputs: [], ...o,
});
const down = async () => { throw new Error('ai down'); };
const t = (title: string) => ({ title, description: null });

test('a confident model decision is used and recorded with its confidence and plan', async () => {
  const p = await routeTask(t('Compare vendors'), model());
  assert.equal(p.agent, 'research');
  assert.equal(p.confidence, 0.9);
  assert.equal(p.stagePlan?.stages[0].agent, 'research');
});

test('obvious human work is never sent to an agent, even if the model would', async () => {
  let asked = false;
  const p = await routeTask(t('Call the vendor and pay the invoice'), async () => { asked = true; return (await model())(); });
  assert.equal(p.agent, null);
  assert.match(p.reason, /person/);
  assert.equal(asked, false);
});

test('below the confidence floor the task is left for a human but offers the best guess as an override', async () => {
  const p = await routeTask(t('Look into the thing'), model({ agent: 'marketing', confidence: MIN_CONFIDENCE - 0.1, missing_inputs: ['which product?'] }));
  assert.equal(p.agent, null);
  assert.equal(p.stagePlan?.suggestedAgent, 'marketing');
  assert.match(p.reason, /which product/);
  assert.match(p.reason, /best guess: marketing/);
});

test('the model can say a person should do it', async () => {
  const p = await routeTask(t('Prepare for the board'), model({ agent: null, can_ai_do: false, human_reason: 'Needs a decision from the board' }));
  assert.equal(p.agent, null);
  assert.equal(p.reason, 'Needs a decision from the board');
});

test('when the model is unavailable the regex rules route the task', async () => {
  const p = await routeTask(t('Research competitor pricing'), down);
  assert.equal(p.agent, 'research');
  assert.equal(p.confidence, 0.7);
  const none = await routeTask(t('Water the plants'), down);
  assert.equal(none.agent, null);
});

test('web-page design carries the designer → code plan through', async () => {
  const p = await routeTask(t('Design the landing page'), model({ category: 'design', agent: 'designer', scope: 'build', stages: [{ agent: 'designer', goal: 'g' }, { agent: 'code', goal: 'build it' }] }));
  assert.deepEqual(p.stagePlan?.stages.map((s) => s.agent), ['designer', 'code']);
  assert.equal(p.stagePlan?.scope, 'build');
});
