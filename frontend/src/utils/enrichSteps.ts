export interface StepMeta { depth: number; color: string }
const palette = ['var(--route-0)','var(--route-1)','var(--route-2)','var(--route-3)'];

type Raw = { id:string; step_type:string; merge_to?:string; route?:string };
const type = (s: Raw) => s.step_type;
const mergeTo = (s: Raw) => s.merge_to;

export function enrichSteps<T extends Raw>(
  steps: T[],
): Array<T & StepMeta> {
  const routeColor = new Map<string,string>();
  let p = 0;                        // Farb‑Index
  const stack:string[] = [];        // erwartete merge‑IDs

  return steps.map(s => {
    while (stack.length && stack[stack.length-1] === s.id) stack.pop();
    const depth = stack.length;

    if (s.route && !routeColor.has(s.route))
        routeColor.set(s.route, palette[p++ % palette.length]);

    if (type(s) === 'DecisionPrompt' && mergeTo(s)) stack.push(mergeTo(s)!);

    return { ...s, depth, color: s.route ? routeColor.get(s.route)! : 'transparent' };
  });
}
