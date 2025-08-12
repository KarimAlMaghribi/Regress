export interface StepMeta { depth: number; color: string }
const palette = ['var(--route-0)','var(--route-1)','var(--route-2)','var(--route-3)'];

type Raw = { id:string; step_type:string; route?:string };

export function enrichSteps<T extends Raw>(
  steps: T[],
): Array<T & StepMeta> {
  const routeColor = new Map<string,string>();
  let p = 0;                        // Farb‑Index
  const stack:string[] = [];        // branch stack

  return steps.map(s => {
    if (!s.route || s.route === 'ROOT') while (stack.length > 0) stack.pop();
    const depth = stack.length;

    if (s.route && !routeColor.has(s.route))
        routeColor.set(s.route, palette[p++ % palette.length]);

    const color = s.route ? routeColor.get(s.route)! : 'transparent';

    if (s.step_type === 'DecisionPrompt') stack.push('__branch__');

    return { ...s, depth, color };
  });
}
