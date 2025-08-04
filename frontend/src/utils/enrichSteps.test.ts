import { describe, it, expect } from 'vitest';
import { enrichSteps } from './enrichSteps';

describe('enrichSteps', () => {
  it('handles linear steps', () => {
    const steps = [
      { id: 'a', step_type: 'ExtractionPrompt' },
      { id: 'b', step_type: 'ScoringPrompt' },
    ];
    const res = enrichSteps(steps);
    expect(res.map(s => s.depth)).toEqual([0,0]);
  });

  it('handles branches', () => {
    const steps = [
      { id: 'a', step_type: 'DecisionPrompt', merge_to: 'c', route: 'r1' },
      { id: 'b', step_type: 'ExtractionPrompt', route: 'r1' },
      { id: 'c', step_type: 'ScoringPrompt' },
    ];
    const res = enrichSteps(steps);
    expect(res[0].depth).toBe(0);
    expect(res[1].depth).toBe(1);
    expect(res[2].depth).toBe(0);
    expect(res[0].color).toBe(res[1].color);
  });
});
