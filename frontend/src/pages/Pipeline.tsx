import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import PipelineEditor from '../components/PipelineEditor';
import { usePipelineStore } from '../hooks/usePipelineStore';
import { enrichSteps } from '../utils/enrichSteps';

export default function PipelinePage() {
  const { id } = useParams();
  const { loadPipeline, steps } = usePipelineStore();
  useEffect(() => { if (id) loadPipeline(id).catch(()=>{}); }, [id]);
  const normalized = useMemo(() => steps.map(s => ({ ...s, type: s.type, mergeTo: s.mergeTo })), [steps]);
  const enriched = useMemo(() => enrichSteps(normalized), [normalized]);
  return (
    <div>
      {enriched.map(st => (
        <div
          key={st.id}
          className="step"
          style={{
            marginLeft: `calc(${st.depth} * 1.5rem)`,
            backgroundColor: st.color,
            borderLeft: st.route ? `4px solid ${st.color}` : 'none'
          }}
        >
          {st.id}
        </div>
      ))}
      <PipelineEditor />
    </div>
  );
}
