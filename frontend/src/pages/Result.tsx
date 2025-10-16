import React, { useEffect, useState } from 'react';
import { Box, Skeleton } from '@mui/material';
import { useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import RunDetails from '../components/RunDetails';
import { PipelineRunResult } from '../types/pipeline';
import { getUploadApiBase } from '../utils/runtimeEnv';

type ResultData = PipelineRunResult;




export default function Result() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ResultData | null>(null);

  useEffect(() => {
    if (!id) return;
    const api = import.meta.env.VITE_HISTORY_URL || 'http://localhost:8090';
    fetch(`${api}/results/${id}`)
      .then(r => r.json())
      .then(setData)
      .catch(e => console.error('load result', e));
  }, [id]);


  const ingest = getUploadApiBase();
  const pdfUrl = `${ingest}/pdf/${id}`;

  return (
    <Box>
      <PageHeader title="Ergebnis" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Analysen', to: '/analyses' }, { label: `Result ${id}` }]} />
      {!data ? (
        <Box>
          <Skeleton variant="rectangular" height={120} sx={{ mb: 2 }} />
          <Skeleton variant="rectangular" height={400} />
        </Box>
      ) : (
        <RunDetails run={data} pdfUrl={pdfUrl} />
      )}
    </Box>
  );
}
