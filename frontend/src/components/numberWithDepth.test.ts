import { describe, it, expect } from 'vitest';
import { numberWithDepth } from '../utils/numberWithDepth';
import { PipelineStep } from '../hooks/usePipelineStore';

describe('numberWithDepth', () => {
  it('numbers steps with depth', () => {
    const steps: PipelineStep[] = [
      { id: 'D1', type: 'DecisionPrompt', promptId: 0, yesKey: 'y', noKey: 'n' },
      { id: 'A1', type: 'ExtractionPrompt', promptId: 0, route: 'y' },
      { id: 'R1', type: 'ScoringPrompt', promptId: 0, route: 'n', mergeKey: true },
      { id: 'M1', type: 'ExtractionPrompt', promptId: 0 },
    ];
    const rows = numberWithDepth(steps);
    expect(rows.map(r => [r.no, r.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 0],
    ]);
  });
});
