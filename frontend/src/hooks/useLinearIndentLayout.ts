import { PipelineStep } from './usePipelineStore';

export interface LayoutRow {
  step: PipelineStep;
  depth: number;
  rowIdx: number;
  rowLabel: string;
  warnings: string[];
}

function toWarnings(step: PipelineStep, depth: number): string[] {
  const w: string[] = [];
  if (step.route && depth === 0) {
    w.push('route bei leerem Branch-Stack');
  }
  if (depth > 0 && (!step.route || step.route === 'ROOT')) {
    w.push('impliziter Merge an erster gemeinsamer Stelle');
  }
  return w;
}

export function useLinearIndentLayout(steps: PipelineStep[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  const stack: string[] = [];
  const counters: number[] = [];
  let depth = 0;
  let idx = 1;
  for (const step of steps) {
    if ((!step.route || step.route === 'ROOT') && stack.length > 0) {
      stack.length = 0;
    }
    depth = stack.length;
    // adjust hierarchical counters
    while (counters.length <= depth) counters.push(0);
    counters.length = depth + 1;
    counters[depth]++;
    const rowLabel = counters.slice(0, depth + 1).join('.');
    const warnings = toWarnings(step, depth);
    rows.push({ step, depth, rowIdx: idx++, rowLabel, warnings });
    if (step.type === 'DecisionPrompt') {
      stack.push('__branch__');
    }
  }
  return rows;
}
