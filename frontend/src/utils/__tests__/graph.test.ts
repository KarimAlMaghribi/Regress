import { describe, it, expect } from 'vitest';
import { buildGraphFromElements } from '../graph';

describe('buildGraphFromElements', () => {
  it('copies text from node data', () => {
    const nodes = [
      { id: '1', data: { text: 'hello', type: 'TriggerPrompt' } },
    ] as any;
    const graph = buildGraphFromElements(nodes, []);
    expect(graph.nodes[0].text).toBe('hello');
  });
});
