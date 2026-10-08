import { describe, expect, test } from 'vitest';
import { compareStreamIds, parseEntries, parseReadGroupReply } from '../../../src/modules/telemetry/worker.js';

const good = JSON.stringify({ name: 'player_join', ts: 1, userId: 5 });

describe('stream reply parsing', () => {
  test('reads XREADGROUP replies and keeps the entry id', () => {
    expect(parseReadGroupReply([['telemetry:events', [['1-0', ['e', good, 's', 'game-server']]]]])).toEqual([
      { id: '1-0', event: { name: 'player_join', ts: 1, userId: 5 } },
    ]);
    expect(parseReadGroupReply(null)).toEqual([]);
  });

  test('malformed entries keep their id with a null event, so they can be acked and skipped', () => {
    expect(
      parseEntries([
        ['2-0', ['e', '{not json']],
        ['3-0', ['e', JSON.stringify({ name: 'evil', ts: 1 })]],
        ['4-0', ['s', 'game-server']],
        ['5-0', null],
        'garbage',
      ]),
    ).toEqual([
      { id: '2-0', event: null },
      { id: '3-0', event: null },
      { id: '4-0', event: null },
      { id: '5-0', event: null },
    ]);
  });

  test('an entry whose dims are off the allow list is malformed too', () => {
    const offList = JSON.stringify({ name: 'purchase_result', ts: 1, dims: { itemId: 'BlueHat' } });
    expect(parseEntries([['6-0', ['e', offList]]])).toEqual([{ id: '6-0', event: null }]);
  });

  test('stream ids order by milliseconds and then sequence, as numbers', () => {
    const ids = ['10-0', '9-5', '9-10', '100-0', '9-9'];
    expect([...ids].sort(compareStreamIds)).toEqual(['9-5', '9-9', '9-10', '10-0', '100-0']);
  });
});
