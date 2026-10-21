import { describe, expect, mock, test } from 'bun:test';
import { createTimerHarness, tick } from './test-timers';

describe('createTimerHarness', () => {
  test('fires due timers in schedule order and leaves later ones pending', async () => {
    const timers = createTimerHarness();
    const order: string[] = [];
    timers.setTimeout(() => order.push('late'), 10);
    timers.setTimeout(() => order.push('early'), 5);
    expect(timers.pending()).toBe(2);

    await timers.advance(7);

    expect(order).toEqual(['early']);
    expect(timers.now()).toBe(7);

    await timers.advanceTo(10);

    expect(order).toEqual(['early', 'late']);
    expect(timers.pending()).toBe(0);
    expect(timers.now()).toBe(10);
  });

  test('timers scheduled by fired callbacks run in the same advance when due', async () => {
    const timers = createTimerHarness();
    const order: string[] = [];
    timers.setTimeout(() => {
      order.push('first');
      timers.setTimeout(() => order.push('chained'), 0);
    }, 5);

    await timers.advance(5);

    expect(order).toEqual(['first', 'chained']);
  });

  test('clearTimeout cancels; tick drains promises without firing timers', async () => {
    const timers = createTimerHarness();
    const fired = mock(() => {});
    timers.clearTimeout(timers.setTimeout(fired, 5));
    let settled = false;
    void Promise.resolve().then(() => {
      settled = true;
    });

    await tick();

    expect(settled).toBe(true);
    expect(fired).not.toHaveBeenCalled();

    await timers.advance(100);

    expect(fired).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });
});
