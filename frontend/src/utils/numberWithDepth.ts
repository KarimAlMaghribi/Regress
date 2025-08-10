import { PipelineStep } from '../hooks/usePipelineStore';

export type NumberedRow = { no: number; depth: number; step: PipelineStep };

export function numberWithDepth(steps: PipelineStep[]): NumberedRow[] {
  const stack: string[] = [];
  let depth = 0;
  let no = 1;
  const rows: NumberedRow[] = [];
  for (const s of steps) {
    if (!s.route && stack.length > 0) {
      stack.pop();
      depth = stack.length;
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
    if (s.mergeKey === true && stack.length > 0) {
      stack.pop();
      depth = stack.length;
    }
  }
  return rows;
}
