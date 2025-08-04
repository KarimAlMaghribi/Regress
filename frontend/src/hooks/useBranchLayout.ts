import { PipelineStep } from './usePipelineStore';

/** describes one visual row in the editor table */
export interface LayoutRow {
  step: PipelineStep;          // real pipeline step (or dummy)
  depth: number;               // 0 = main flow, 1 = inside branch
  branchKey?: string;          // e.g. 'true'
  isBranchHeader?: boolean;
  isBranchEnd?: boolean;
  rowIdx: string;             /* hierarchical row number e.g. 2.1 */
  cKey?: string;              /* composite key decisionID+route */
}

/**
 *   Converts the linear steps array into a hierarchical view.
 */
export function useBranchLayout(steps: PipelineStep[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  const id2idx = Object.fromEntries(steps.map((s, i) => [s.id, i]));
  const seen = new Set<string>();
  const counters: number[] = [0];

  const nextIndex = (depth: number): string => {
    while (counters.length <= depth) counters.push(0);
    counters[depth]++;
    for (let i = depth + 1; i < counters.length; i++) counters[i] = 0;
    return counters.slice(0, depth + 1).join('.');
  };

  const processBranchChain = (startIdx: number, depth: number, branchKey: string, cKey: string) => {
    let idx = startIdx;
    while (idx < steps.length) {
      const cur = steps[idx];
      if (seen.has(cur.id)) break;
      processStep(idx, depth, branchKey, cKey);
      if (cur.mergeTo) break;
      idx += 1;
    }
  };

  const processStep = (idx: number, depth: number, branchKey?: string, cKey?: string) => {
    const s = steps[idx];
    const rowIdx = nextIndex(depth);
    rows.push({ step: s, depth, branchKey, isBranchEnd: !!s.mergeTo, rowIdx, cKey });
    seen.add(s.id);

    if (s.targets) {
      Object.entries(s.targets)
        .filter(([, targetId]) => targetId)
        .forEach(([key, targetId]) => {
          const subKey = `${s.id}:${key}`;
          counters.push(0);
          const headerIdx = counters.slice(0, depth + 1).join('.');
          rows.push({
            step: s,
            depth: depth + 1,
            branchKey: key,
            isBranchHeader: true,
            rowIdx: headerIdx,
            cKey: subKey,
          });
          const startIdx = id2idx[targetId];
          if (startIdx !== undefined) {
            processBranchChain(startIdx, depth + 1, key, subKey);
          }
          counters.pop();
        });
    }
  };

  for (let i = 0; i < steps.length; i++) {
    if (seen.has(steps[i].id)) continue;
    processStep(i, 0);
  }

  return rows;
}
