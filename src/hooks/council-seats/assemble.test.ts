/**
 * Pure seat assembly: the `Seats:` trigger parse, the per-kind body
 * vocabulary, and the fail-open resolver boundary.
 */
import { describe, expect, test } from 'bun:test';

import {
  assembleCouncilPrompt,
  buildSeatPrompt,
  parseSeatRefs,
  SEAT_REASONS,
  seatBodyOf,
} from './assemble';
import type { SeatRequest, SeatResult } from './types';

const seatsOf = (refs: string[]): SeatRequest[] =>
  refs.map((seat) => ({ seat }));

describe('parseSeatRefs', () => {
  test('finds the FINAL Seats line and its refs', () => {
    const parsed = parseSeatRefs(
      [
        'Question',
        'Seats: earl-1, earl-2',
        'middle',
        'Seats: ses_a , earl-3',
      ].join('\n'),
    );
    expect(parsed?.triggerIndex).toBe(3);
    expect(parsed?.refs).toEqual(['ses_a', 'earl-3']);
  });

  test('returns undefined without a trigger line', () => {
    expect(parseSeatRefs('no refs here\nseats: lowercase')).toBeUndefined();
  });

  test('drops empty refs but still reports the line', () => {
    const parsed = parseSeatRefs('Question\nSeats: ,  ,');
    expect(parsed?.triggerIndex).toBe(1);
    expect(parsed?.refs).toEqual([]);
  });
});

describe('seatBodyOf', () => {
  test('completed text is verbatim', () => {
    expect(seatBodyOf({ kind: 'completed', text: '  RAW text\n' })).toBe(
      '  RAW text\n',
    );
  });

  test('every placeholder kind uses its canonical tail', () => {
    for (const kind of [
      'running',
      'missing',
      'ambiguous',
      'stale',
      'empty',
      'error',
    ] as const) {
      expect(seatBodyOf({ kind, reason: SEAT_REASONS[kind] })).toBe(
        `[no response — ${SEAT_REASONS[kind]}]`,
      );
    }
  });

  test('a custom reason tail is preserved (managed terminal shape)', () => {
    expect(seatBodyOf({ kind: 'error', reason: 'no output (cancelled)' })).toBe(
      '[no response — no output (cancelled)]',
    );
  });

  test('a blank reason falls back to the kind default', () => {
    expect(seatBodyOf({ kind: 'missing', reason: '  ' })).toBe(
      '[no response — unresolved ref]',
    );
  });
});

describe('buildSeatPrompt', () => {
  const prompt = 'Question?\nSeats: earl-1';

  test('strips the trigger, trims trailing newlines, appends sections', () => {
    expect(
      buildSeatPrompt(`${prompt}\n\n`, [
        { kind: 'completed', text: 'ANSWER', label: 'councillor-alpha' },
      ]),
    ).toBe('Question?\n\n## Seat: councillor-alpha\nANSWER');
  });

  test('the label falls back to the ref', () => {
    expect(buildSeatPrompt(prompt, [{ kind: 'missing', reason: 'x' }])).toBe(
      'Question?\n\n## Seat: earl-1\n[no response — x]',
    );
  });

  test('keywords before the trigger stay byte-identical', () => {
    const withTail = 'Body\nSeats: a\nTRAILING TEXT';
    expect(buildSeatPrompt(withTail, [{ kind: 'completed', text: 'A' }])).toBe(
      'Body\nTRAILING TEXT\n\n## Seat: a\nA',
    );
  });

  test('an empty-refs line reports itself as one section', () => {
    expect(buildSeatPrompt('Question?\nSeats: , ,', [])).toBe(
      'Question?\n\n[no seat references were provided]',
    );
  });

  test('a missing result degrades to ambiguity instead of a bare heading', () => {
    expect(buildSeatPrompt(prompt, [])).toBe(
      'Question?\n\n## Seat: earl-1\n[no response — unverified result]',
    );
  });

  test('no trigger line is byte-identical', () => {
    const untouched = 'Question without refs';
    expect(buildSeatPrompt(untouched, [])).toBe(untouched);
  });
});

describe('assembleCouncilPrompt', () => {
  test('resolves each seat in order and never mutates the input', async () => {
    const prompt = 'Question?\nSeats: earl-1, earl-2';
    const seats = seatsOf(['earl-1', 'earl-2']);
    const seen: Array<[string, SeatRequest[]]> = [];
    const assembled = await assembleCouncilPrompt({
      prompt,
      parentSessionID: 'ses_parent',
      seats,
      resolveSeats: async (parent, requested) => {
        seen.push([parent, requested]);
        return [
          { kind: 'completed', text: 'ONE', label: 'councillor-a' },
          { kind: 'completed', text: 'TWO', label: 'councillor-b' },
        ];
      },
    });
    expect(seen).toEqual([['ses_parent', seats]]);
    expect(prompt).toBe('Question?\nSeats: earl-1, earl-2');
    expect(assembled).toBe(
      [
        'Question?',
        '',
        '## Seat: councillor-a',
        'ONE',
        '',
        '## Seat: councillor-b',
        'TWO',
      ].join('\n'),
    );
  });

  test('a resolver rejection becomes one placeholder per ref and never throws', async () => {
    const assembled = await assembleCouncilPrompt({
      prompt: 'Question?\nSeats: earl-1, earl-2',
      parentSessionID: 'ses_parent',
      seats: seatsOf(['earl-1', 'earl-2']),
      resolveSeats: async () => {
        throw new Error('board exploded');
      },
    });
    expect(assembled).toBe(
      [
        'Question?',
        '',
        '## Seat: earl-1',
        '[no response — resolver error]',
        '',
        '## Seat: earl-2',
        '[no response — resolver error]',
      ].join('\n'),
    );
  });

  test('a short or malformed result array degrades per seat', async () => {
    const assembled = await assembleCouncilPrompt({
      prompt: 'Question?\nSeats: earl-1, earl-2',
      parentSessionID: 'ses_parent',
      seats: seatsOf(['earl-1', 'earl-2']),
      resolveSeats: async () =>
        [
          { kind: 'completed', text: 'ONE' },
          { kind: 'not-a-kind', reason: 'x' },
          { kind: 'completed', text: 'EXTRA' },
        ] as SeatResult[],
    });
    expect(assembled).toContain('## Seat: earl-1\nONE');
    expect(assembled).toContain(
      '## Seat: earl-2\n[no response — resolver returned no result for this seat]',
    );
    expect(assembled).not.toContain('EXTRA');
  });

  test('an empty-refs line resolves nothing at all', async () => {
    let called = false;
    const assembled = await assembleCouncilPrompt({
      prompt: 'Question?\nSeats: , ,',
      parentSessionID: 'ses_parent',
      seats: [],
      resolveSeats: async () => {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
    expect(assembled).toBe('Question?\n\n[no seat references were provided]');
  });

  test('a prompt without a trigger line is byte-identical', async () => {
    const prompt = 'Synthesis with pasted answers.\n## Seat: old\nTEXT';
    const assembled = await assembleCouncilPrompt({
      prompt,
      parentSessionID: 'ses_parent',
      seats: [],
      resolveSeats: async () => {
        throw new Error('must not be called');
      },
    });
    expect(assembled).toBe(prompt);
  });
});
