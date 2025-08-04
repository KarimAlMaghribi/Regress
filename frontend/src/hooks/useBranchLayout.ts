import { PipelineStep } from './usePipelineStore';

/** describes one visual row in the editor table */
export interface LayoutRow {
  step: PipelineStep;          // real pipeline step (or dummy)
  depth: number;               // 0 = main flow, 1 = inside branch
  branchKey?: string;          // e.g. 'true'
  isBranchHeader?: boolean;
  isBranchEnd?: boolean;
  rowIdx: number;             /* 1‑based visual row number */
  cKey?: string;              /* composite key decisionID+route */
}

/**
 *   Converts the linear steps array into a hierarchical view.
 */
export function useBranchLayout(steps: PipelineStep[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  const id2idx = Object.fromEntries(steps.map((s,i)=>[s.id,i]));
  let visual = 0;

  steps.forEach((s) => {
    if (s.targets) {
      // Decision row itself
      rows.push({ step:s, depth:0, rowIdx:++visual });

      Object.entries(s.targets)
        .filter(([, targetId]) => targetId)
        .forEach(([key, targetId]) => {
          const cKey = `${s.id}:${key}`;
          rows.push({ step:s, depth:1, branchKey:key, isBranchHeader:true, rowIdx:++visual, cKey });
          let idx = id2idx[targetId];
          while (idx !== undefined) {
            const cur = steps[idx];
            rows.push({
              step:cur, depth:1, branchKey:key, isBranchEnd:!!cur.mergeTo,
              rowIdx:++visual, cKey
            });
            if (cur.mergeTo) break;
            idx += 1;
            if (idx >= steps.length) break;           /* end of list */
            if (idx in id2idx && steps[idx].targets) break;  /* nested decision */
          }
        });
    } else if (!rows.find(r=>r.step.id===s.id)) {
      rows.push({ step:s, depth:0, rowIdx:++visual });
    }
  });
  return rows;
}
