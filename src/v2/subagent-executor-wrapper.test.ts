import { describe, expect, test } from 'bun:test';
import {
  createSubagentExecutorWrapper,
  type SubagentStructuredLaunch,
} from './subagent-executor-wrapper';

function recorder() {
  const launches: SubagentStructuredLaunch[] = [];
  return {
    launches,
    register: (launch: SubagentStructuredLaunch) => {
      launches.push(launch);
    },
  };
}

const ctx = { id: 'call_1', sessionID: 'parent_1' };

describe('createSubagentExecutorWrapper', () => {
  test('registers a running background launch from the structured result', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const result = {
      output: { sessionID: 'ses_child', status: 'running' },
      content:
        'The subagent is working in the background (sessionID: ses_child).',
      metadata: { sessionID: 'ses_child', status: 'running' },
    };
    const original = async () => result;
    const wrapped = wrapper.wrap(original);

    const returned = await wrapped({}, ctx);

    // Result is passed through byte-for-byte (same object identity).
    expect(returned).toBe(result);
    expect(rec.launches).toEqual([
      {
        callID: 'call_1',
        parentSessionID: 'parent_1',
        childTaskID: 'ses_child',
        state: 'running',
        background: false,
        result: result.content,
      },
    ]);
  });

  test('maps a completed foreground result to the terminal state', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const content =
      '<subagent sessionID="ses_done" state="completed">ok</subagent>';
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_done', status: 'completed' },
      content,
      metadata: { sessionID: 'ses_done', status: 'completed' },
    }));

    const returned = await wrapped({}, ctx);

    expect((returned as { content: string }).content).toBe(content);
    // Only the text INSIDE the block reaches the structured launch: the
    // block is the host's rendering, not the child's public answer.
    expect(rec.launches[0]).toMatchObject({
      childTaskID: 'ses_done',
      state: 'completed',
      result: 'ok',
    });
  });

  test('a completed result passes the child text verbatim through register', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    // Host-authored prose with intentional spacing/quotes: the wrapper must
    // carry the extracted inner text byte-for-byte, never reformat it.
    const content =
      '<subagent sessionID="ses_done" state="completed">\n  <result>  done &amp; dusted  </result>\n</subagent>';
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_done', status: 'completed' },
      content,
      metadata: { sessionID: 'ses_done', status: 'completed' },
    }));

    await wrapped({}, ctx);

    expect(rec.launches).toHaveLength(1);
    expect(rec.launches[0].result).toBe(
      '<result>  done &amp; dusted  </result>',
    );
  });

  test('an empty subagent block omits the result field so the gate sees no answer', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    // The whole block used to be counted as the answer text: the terminal
    // gate saw a nonempty result and recorded a success for a child that
    // returned nothing. Only the block's inner text reaches the gate.
    const content =
      '<subagent sessionID="ses_done" state="completed"></subagent>';
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_done', status: 'completed' },
      content,
      metadata: { sessionID: 'ses_done', status: 'completed' },
    }));

    const returned = await wrapped({}, ctx);

    // The host's returned content stays exactly as authored.
    expect((returned as { content: string }).content).toBe(content);
    expect(rec.launches).toHaveLength(1);
    expect(rec.launches[0]).toEqual({
      callID: 'call_1',
      parentSessionID: 'parent_1',
      childTaskID: 'ses_done',
      state: 'completed',
      background: false,
    });
    expect('result' in rec.launches[0]).toBe(false);
  });

  test('a whitespace-only subagent block omits the result field', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_done', status: 'completed' },
      content:
        '<subagent sessionID="ses_done" state="completed">\n\n</subagent>',
      metadata: { sessionID: 'ses_done', status: 'completed' },
    }));

    await wrapped({}, ctx);

    expect(rec.launches).toHaveLength(1);
    expect('result' in rec.launches[0]).toBe(false);
  });

  test('an unterminated subagent block omits the result field', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const content = '<subagent sessionID="ses_done" state="completed">partial';
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_done', status: 'completed' },
      content,
      metadata: { sessionID: 'ses_done', status: 'completed' },
    }));

    const returned = await wrapped({}, ctx);

    expect((returned as { content: string }).content).toBe(content);
    expect(rec.launches[0]).not.toHaveProperty('result');
  });

  test('a quoted attribute cannot leak into the extracted answer text', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const content =
      '<subagent sessionID="ses_done" state="completed" description="Check a > b">done</subagent>';
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_done', status: 'completed' },
      content,
      metadata: { sessionID: 'ses_done', status: 'completed' },
    }));

    await wrapped({}, ctx);

    expect(rec.launches[0].result).toBe('done');
  });

  test('a result with no text omits the result field (fail-open)', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_done', status: 'completed' },
      content: '   ',
      metadata: { sessionID: 'ses_done', status: 'completed' },
    }));

    await wrapped({}, ctx);

    expect(rec.launches).toHaveLength(1);
    expect('result' in rec.launches[0]).toBe(false);
  });

  test('carries plain-text content that is not a subagent block', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_child', status: 'running' },
      content:
        'The subagent is working in the background (sessionID: ses_child).',
      metadata: { sessionID: 'ses_child', status: 'running' },
    }));

    await wrapped({}, ctx);

    expect(rec.launches[0].result).toBe(
      'The subagent is working in the background (sessionID: ses_child).',
    );
  });

  test('carries plain text that mentions the subagent tag name', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const content = 'Use <subagent> as the tool name in this example.';
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_child', status: 'completed' },
      content,
      metadata: { sessionID: 'ses_child', status: 'completed' },
    }));

    await wrapped({}, ctx);

    expect(rec.launches[0].result).toBe(content);
  });

  test('fails open when the result carries no structured session ID', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const result = { output: {}, content: 'not a delegated launch' };
    const wrapped = wrapper.wrap(async () => result);

    expect(await wrapped({}, ctx)).toBe(result);
    expect(rec.launches).toHaveLength(0);
  });

  test('fails open when the call has no call ID', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_child', status: 'running' },
    }));

    await wrapped({}, {});
    await wrapped({}, undefined);

    expect(rec.launches).toHaveLength(0);
  });

  test('fails open when the executor has no parent session identity', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const result = { metadata: { sessionID: 'ses_child' } };
    expect(await wrapper.wrap(async () => result)({}, { id: 'call_1' })).toBe(
      result,
    );
    expect(rec.launches).toEqual([]);
  });

  test('registers a failed launch from the host failure sentence and rethrows the original error', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const failure = new Error('Subagent failed (sessionID: ses_fail): boom');
    const wrapped = wrapper.wrap(async () => {
      throw failure;
    });

    let thrown: unknown;
    try {
      await wrapped({}, ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(rec.launches).toEqual([
      {
        callID: 'call_1',
        parentSessionID: 'parent_1',
        childTaskID: 'ses_fail',
        state: 'error',
        background: false,
        result: failure.message,
      },
    ]);
  });

  test('registers a cancelled launch from the host failure sentence', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const wrapped = wrapper.wrap(async () => {
      throw new Error('Subagent cancelled (sessionID: ses_stop): stopped');
    });

    await expect(wrapped({}, ctx)).rejects.toThrow('Subagent cancelled');

    expect(rec.launches[0]).toMatchObject({
      childTaskID: 'ses_stop',
      state: 'cancelled',
    });
  });

  test('fails open on an unrecognized failure message', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const failure = new Error('network down');
    const wrapped = wrapper.wrap(async () => {
      throw failure;
    });

    let thrown: unknown;
    try {
      await wrapped({}, ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(rec.launches).toHaveLength(0);
  });

  test('a throwing register never alters the tool result', async () => {
    const wrapper = createSubagentExecutorWrapper({
      register: () => {
        throw new Error('registration exploded');
      },
    });
    const result = {
      output: { sessionID: 'ses_child', status: 'running' },
    };
    const wrapped = wrapper.wrap(async () => result);

    expect(await wrapped({}, ctx)).toBe(result);
  });

  test('an async registration rejection never alters the tool result', async () => {
    const wrapper = createSubagentExecutorWrapper({
      register: async () => {
        throw new Error('registration rejected');
      },
    });
    const result = {
      output: { sessionID: 'ses_child', status: 'running' },
    };
    const wrapped = wrapper.wrap(async () => result);

    expect(await wrapped({}, ctx)).toBe(result);
    // Let the swallowed rejection settle before the test ends.
    await Promise.resolve();
  });

  test('owns() marks wrapped executors so replays cannot double-wrap', () => {
    const wrapper = createSubagentExecutorWrapper({ register: () => {} });
    const original = async () => ({});
    const wrapped = wrapper.wrap(original);

    expect(wrapper.owns(wrapped)).toBe(true);
    expect(wrapper.owns(original)).toBe(false);
    expect(wrapper.owns(undefined)).toBe(false);
  });
});
