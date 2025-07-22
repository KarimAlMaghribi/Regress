import { useCallback } from 'react';
import { Node, Edge } from 'reactflow';

const EDGE_STYLES: Record<string, { stroke: string; strokeDasharray?: string }> = {
  always: { stroke: '#757575' },
  onTrue: { stroke: '#4caf50' },
  onScore: { stroke: '#2196f3' },
  control: { stroke: '#ab47bc', strokeDasharray: '4 2' },
};

export default function useAutoConnect(nodes: Node[], edges: Edge[]) {
  const inDegree = useCallback(
    (id: string) => edges.filter(e => e.target === id).length,
    [edges],
  );

  const leaves = useCallback(
    () => nodes.filter(n => !edges.some(e => e.source === n.id)),
    [nodes, edges],
  );

  const findLastOfType = useCallback(
    (type: string, start: Node | null): Node | null => {
      let cur = start;
      while (cur) {
        if ((cur.data as any).type === type) return cur;
        const back = edges.find(e => e.target === cur!.id);
        if (!back) return null;
        cur = nodes.find(n => n.id === back.source) || null;
      }
      return null;
    },
    [nodes, edges],
  );

  return useCallback(
    (newNode: Node, context: Node | null): Edge[] => {
      const mkEdge = (s: string, t: string, type: string): Edge => ({
        id: `${s}-${t}-${type}`,
        source: s,
        target: t,
        data: { edge_type: type },
        animated: ['onTrue', 'onScore'].includes(type),
        style: EDGE_STYLES[type] ?? EDGE_STYLES.always,
      });
      const res: Edge[] = [];
      switch ((newNode.data as any).type) {
        case 'TriggerPrompt':
          nodes.forEach(n => {
            if ((n.data as any).type !== 'TriggerPrompt' && inDegree(n.id) === 0) {
              res.push(mkEdge(newNode.id, n.id, 'always'));
            }
          });
          break;
        case 'AnalysisPrompt':
          if (context) res.push(mkEdge(context.id, newNode.id, 'always'));
          break;
        case 'DecisionPrompt':
          const last = findLastOfType('AnalysisPrompt', context);
          if (last) res.push(mkEdge(last.id, newNode.id, 'always'));
          break;
        case 'FollowUpPrompt':
          if (context) res.push(mkEdge(context.id, newNode.id, 'onTrue'));
          break;
        case 'FinalPrompt':
          leaves().forEach(src => res.push(mkEdge(src.id, newNode.id, 'always')));
          break;
        case 'MetaPrompt':
          if (context) {
            res.push(mkEdge(context.id, newNode.id, 'control'));
            res.push(mkEdge(newNode.id, context.id, 'control'));
          }
          break;
      }
      return res.filter(
        e =>
          !edges.some(
            ex =>
              ex.source === e.source &&
              ex.target === e.target &&
              (ex.data?.edge_type ?? 'always') === e.data?.edge_type,
          ),
      );
    },
    [nodes, edges, inDegree, leaves, findLastOfType],
  );
}
