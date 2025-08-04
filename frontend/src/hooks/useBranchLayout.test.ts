import { describe, it, expect } from 'vitest';
import { useBranchLayout } from './useBranchLayout';
import { PipelineStep } from './usePipelineStore';

describe('useBranchLayout', () => {
  it('numbers branch steps starting at 1', () => {
    const steps: PipelineStep[] = [
      {
        id: 'a',
        type: 'DecisionPrompt',
        promptId: 0,
        yesKey: 'y',
        noKey: 'n',
        mergeKey: 'm',
        targets: { y: 'b' },
      },
      {
        id: 'b',
        type: 'ExtractionPrompt',
        promptId: 0,
        mergeTo: 'c',
      },
      {
        id: 'c',
        type: 'ScoringPrompt',
        promptId: 0,
      },
    ];
    const rows = useBranchLayout(steps).filter(r => !r.isBranchHeader);
    expect(rows.map(r => r.rowIdx)).toEqual(['1', '1.1', '2']);
  });
});
