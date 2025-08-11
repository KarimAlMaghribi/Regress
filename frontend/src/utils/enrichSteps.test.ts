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
      { id: 'a', step_type: 'DecisionPrompt' },
      { id: 'b', step_type: 'ExtractionPrompt', route: 'r1' },
      { id: 'c', step_type: 'ScoringPrompt', route: 'r1', merge_key: true },
      { id: 'd', step_type: 'ExtractionPrompt' },
    ];
    const res = enrichSteps(steps);
    expect(res.map(s => s.depth)).toEqual([0,1,1,0]);
    expect(res[1].color).toBe(res[2].color);
  });
});
