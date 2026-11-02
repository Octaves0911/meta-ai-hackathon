import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSelf, matchPerson, spokenName } from '../src/insights/people.js';

const team = [{ id: '1', username: 'priya' }, { id: '2', username: 'sam' }, { id: '3', username: 'dana.k' }, { id: '4', username: 'leo' }, { id: '5', username: 'samuel' }];

test('exact username, any case and punctuation', () => {
  assert.equal(matchPerson('Priya,', team)?.id, '1');
  assert.equal(matchPerson("Leo's", team)?.id, '4');
});
test('first name of a dotted username', () => assert.equal(matchPerson('Dana', team)?.id, '3'));
test('a misheard name is matched by edit distance', () => assert.equal(matchPerson('Pria', team)?.id, '1'));
test('ambiguous prefixes return nobody instead of guessing', () => assert.equal(matchPerson('Sa', team), null));
test('exact beats prefix: sam vs samuel', () => assert.equal(matchPerson('sam', team)?.id, '2'));
test('strangers are not matched', () => { assert.equal(matchPerson('Rohit', team), null); assert.equal(matchPerson('', team), null); });
test('self references', () => { assert.ok(isSelf('I')); assert.ok(!isSelf(null)); assert.ok(!isSelf('Priya')); });
test('spoken name display', () => assert.equal(spokenName("rohit's"), 'Rohit'));
