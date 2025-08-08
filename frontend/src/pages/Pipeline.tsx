import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import PipelineLinearView from '../components/PipelineLinearView';
import { usePipelineStore } from '../hooks/usePipelineStore';

export default function PipelinePage() {
  const { id } = useParams();
  const { loadPipeline, steps } = usePipelineStore();
  useEffect(() => { if (id) loadPipeline(id).catch(()=>{}); }, [id]);
  return <PipelineLinearView steps={steps} />;
}
