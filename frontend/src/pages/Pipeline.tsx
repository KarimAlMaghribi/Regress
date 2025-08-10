import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import PipelineEditor from '../components/PipelineEditor';
import { usePipelineStore } from '../hooks/usePipelineStore';
import { Typography } from '@mui/material';

export default function PipelinePage() {
  const { id } = useParams();
  const { loadPipeline } = usePipelineStore();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    loadPipeline(id).catch(e => setError(String(e)));
  }, [id, loadPipeline]);

  if (error) {
    return <Typography color="error">Fehler beim Laden der Pipeline</Typography>;
  }

  return <PipelineEditor />;
}
