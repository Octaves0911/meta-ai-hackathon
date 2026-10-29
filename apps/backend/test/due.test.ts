import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDue, taskTitle, todayInTz } from '../src/services/due.js';

// 2026-10-30 is a Friday.
const TODAY = '2026-10-30';

test('relative deadlines resolve to dates', () => {
  assert.equal(resolveDue('by today', TODAY), '2026-10-30');
  assert.equal(resolveDue('tomorrow', TODAY), '2026-10-31');
  assert.equal(resolveDue('in 3 days', TODAY), '2026-11-02');
  assert.equal(resolveDue('in 2 weeks', TODAY), '2026-11-13');
  assert.equal(resolveDue('next week', TODAY), '2026-11-02'); // Monday
  assert.equal(resolveDue('next month', TODAY), '2026-11-30');
  assert.equal(resolveDue('end of the month', TODAY), '2026-10-31');
});

test('weekday names pick the next occurrence after today', () => {
  assert.equal(resolveDue('by Friday', TODAY), '2026-11-06', 'said on a Friday => next Friday');
  assert.equal(resolveDue('on monday', TODAY), '2026-11-02');
  assert.equal(resolveDue('end of week', '2026-10-28'), '2026-10-30');
});

test('month-day dates roll to next year once passed and respect month length', () => {
  assert.equal(resolveDue('October 31', TODAY), '2026-10-31');
  assert.equal(resolveDue('Oct 30', TODAY), '2026-10-30', 'today still counts');
  assert.equal(resolveDue('Aug 1', TODAY), '2027-08-01');
  assert.equal(resolveDue('feb 30', TODAY), null, 'impossible date');
  assert.equal(resolveDue('Dec 31st', TODAY), '2026-12-31');
});

test('no recognisable date / bad input => null', () => {
  assert.equal(resolveDue('whenever', TODAY), null);
  assert.equal(resolveDue(null, TODAY), null);
  assert.equal(resolveDue('friday', 'garbage'), null);
});

test('taskTitle strips commitment phrasing and trailing deadlines', () => {
  assert.equal(taskTitle('I will send the report by Friday.'), 'Send the report');
  assert.equal(taskTitle('Aman will update the pricing page before October 31'), 'Update the pricing page');
  assert.equal(taskTitle('Can you draft the launch email?'), 'Draft the launch email');
  assert.equal(taskTitle('Can you draft the launch email tomorrow?'), 'Draft the launch email');
  assert.equal(taskTitle('I will fix the bug next week.'), 'Fix the bug');
  assert.equal(taskTitle('Prepare release checklist'), 'Prepare release checklist');
  assert.equal(taskTitle('x'.repeat(300)).length, 100);
});

test('todayInTz uses the requested time zone, not UTC', () => {
  const t = new Date('2026-10-29T20:30:00Z'); // still Thursday in UTC, already Friday in India
  assert.equal(todayInTz(t, 'UTC'), '2026-10-29');
  assert.equal(todayInTz(t, 'Asia/Kolkata'), '2026-10-30');
});
