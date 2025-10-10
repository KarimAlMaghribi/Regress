import React from 'react';
import { PipelineStep } from '../hooks/usePipelineStore';

export type NumberedRow = { no: number; depth: number; step: PipelineStep };

export function numberWithDepth(steps: PipelineStep[]): NumberedRow[] {
  const stack: string[] = [];
  let depth = 0;
  let no = 1;
  const rows: NumberedRow[] = [];
  for (const s of steps) {
    if (!s.route || s.route === 'ROOT') {
      stack.length = 0;
      depth = 0;
    }
    let curDepth = depth;
    if (s.route && stack.length === 0) {
      curDepth = 1;
    }
    rows.push({ no: no++, depth: curDepth, step: s });
    if (s.type === 'DecisionPrompt') {
      stack.push('__branch__');
      depth = stack.length;
      continue;
    }
  }
  return rows;
}

export default function PipelineLinearView({ steps }: { steps: PipelineStep[] }) {
  const rows = numberWithDepth(steps);
  return (
      <div>
        {rows.map(({ no, depth, step }) => (
            <div
                key={step.id}
                style={{ marginLeft: depth * 16, display: 'flex', gap: 8, alignItems: 'baseline' }}
            >
              <span style={{ width: 28, textAlign: 'right' }}>{no}.</span>
              <strong>{step.type}</strong>
              {step.type === 'DecisionPrompt' && step.yesKey && step.noKey && (
                  <span style={{ opacity: 0.7 }}>
              &nbsp;({step.yesKey} / {step.noKey})
            </span>
              )}
              <span style={{ opacity: 0.6 }}>&nbsp;[route: {step.route ?? 'Root'}]</span>
            </div>
        ))}
      </div>
  );
}
