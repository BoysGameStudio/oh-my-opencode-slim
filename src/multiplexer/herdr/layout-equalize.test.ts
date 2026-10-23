import { describe, expect, test } from 'bun:test';
import {
  equalizeUpdates,
  type HerdrLayoutNode,
  paneSpan,
} from './layout-equalize';

function pane(id: string): HerdrLayoutNode {
  return { type: 'pane', pane_id: id };
}

function split(
  direction: 'down' | 'right',
  first: HerdrLayoutNode,
  second: HerdrLayoutNode,
): HerdrLayoutNode {
  return { type: 'split', direction, ratio: 0.5, first, second };
}

describe('paneSpan', () => {
  test('sums along the split axis and takes the larger side across it', () => {
    // Three columns wide, one row tall.
    const inner = split(
      'right',
      split('right', pane('a'), pane('b')),
      pane('c'),
    );

    expect(paneSpan(pane('a'), 'down')).toBe(1);
    expect(paneSpan(inner, 'right')).toBe(3);
    // A horizontal split does not divide vertical space: still one row.
    expect(paneSpan(inner, 'down')).toBe(1);

    const vertical = split('down', pane('a'), pane('b'));
    expect(paneSpan(vertical, 'down')).toBe(2);
    expect(paneSpan(vertical, 'right')).toBe(1);
  });
});

describe('equalizeUpdates', () => {
  test('equalizes a three-pane agent chain to 2/3 and 1/2', () => {
    const chain = split('down', split('down', pane('a'), pane('b')), pane('c'));
    const root = split('right', pane('main'), chain);

    expect(equalizeUpdates(root, 'main')).toEqual([
      { path: [true], ratio: 2 / 3 },
      { path: [true, false], ratio: 1 / 2 },
    ]);
  });

  test('equalizes a four-pane agent chain to 3/4, 2/3 and 1/2', () => {
    const chain = split(
      'down',
      split('down', split('down', pane('a'), pane('b')), pane('c')),
      pane('d'),
    );
    const root = split('right', pane('main'), chain);

    expect(equalizeUpdates(root, 'main')).toEqual([
      { path: [true], ratio: 3 / 4 },
      { path: [true, false], ratio: 2 / 3 },
      { path: [true, false, false], ratio: 1 / 2 },
    ]);
  });

  test('uses the larger side (max) for perpendicular splits', () => {
    // `inner` is two rows tall (down) and two columns wide (right): the
    // vertical span is max(2, 1) = 2, not the sum 3.
    const inner = split(
      'right',
      split('down', pane('a'), pane('b')),
      pane('c'),
    );
    expect(paneSpan(inner, 'down')).toBe(2);
    expect(paneSpan(inner, 'right')).toBe(2);

    const root = split('down', inner, pane('d'));
    // A naive pane count would make the root 3/4; span says 2/3.
    expect(equalizeUpdates(root, 'main')).toEqual([
      { path: [], ratio: 2 / 3 },
      { path: [false], ratio: 1 / 2 },
      { path: [false, false], ratio: 1 / 2 },
    ]);
  });

  test('skips splits containing the main pane but equalizes deeper agents', () => {
    const agents = split(
      'down',
      split('down', pane('a1'), pane('a2')),
      pane('a3'),
    );
    // The main pane is nested deep inside the first child: every split on its
    // path must be left untouched, including the root.
    const mainSide = split(
      'right',
      pane('side'),
      split('down', pane('main'), pane('extra')),
    );
    const root = split('down', mainSide, agents);

    const updates = equalizeUpdates(root, 'main');

    expect(updates).toEqual([
      { path: [true], ratio: 2 / 3 },
      { path: [true, false], ratio: 1 / 2 },
    ]);
    expect(updates.every((update) => update.path[0] === true)).toBe(true);
  });

  test('returns no updates for a single-pane tab', () => {
    expect(equalizeUpdates(pane('main'), 'main')).toEqual([]);
  });
});
