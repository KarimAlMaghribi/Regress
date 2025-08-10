import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { numberWithDepth } from '../utils/numberWithDepth';
import { usePipelineStore } from '../hooks/usePipelineStore';

export default function PipelinePage() {
  const { id } = useParams();
  const { loadPipeline, steps } = usePipelineStore();
  useEffect(() => { if (id) loadPipeline(id).catch(()=>{}); }, [id]);
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
          {step.route && <span style={{ opacity: 0.6 }}>&nbsp;[route: {step.route}]</span>}
          {step.mergeKey && <span style={{ opacity: 0.6 }}>&nbsp;[merge]</span>}
        </div>
      ))}
    </div>
  );
}
