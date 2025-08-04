import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import PipelineEditor from '../components/PipelineEditor';
import { usePipelineStore } from '../hooks/usePipelineStore';

export default function PipelinePage() {
  const { id } = useParams();
  const { loadPipeline } = usePipelineStore();
  useEffect(() => { if (id) loadPipeline(id).catch(()=>{}); }, [id]);
  return <PipelineEditor />;
}
