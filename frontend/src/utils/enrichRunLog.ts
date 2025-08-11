import { enrichSteps } from './enrichSteps';
import type { RunStep } from '../types/pipeline';

export const enrichRunLog = (log: RunStep[]) =>
  enrichSteps(
    log.map(l => ({
      id: l.step_id,
      route: l.route,
      merge_key: l.merge_key,
      step_type: l.prompt_type,
    })),
  ).map((m, i) => ({ ...log[i], ...m }));
