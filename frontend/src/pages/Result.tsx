import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Tabs,
  Tab,
  Skeleton,
} from '@mui/material';
import { useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import PromptDetailsTable from '../components/PromptDetailsTable';
import PdfViewer from '../components/PdfViewer';
import { PipelineRunResult, TextPosition } from '../types/pipeline';

type ResultData = PipelineRunResult;




export default function Result() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ResultData | null>(null);
  const [tab, setTab] = useState(0);
  const [highlight, setHighlight] = useState<TextPosition | null>(null);

  useEffect(() => {
    if (!id) return;
    const api = import.meta.env.VITE_HISTORY_URL || 'http://localhost:8090';
    fetch(`${api}/results/${id}`)
      .then(r => r.json())
      .then(setData)
      .catch(e => console.error('load result', e));
  }, [id]);


  const ingest = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';
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
        <>
          <Typography variant="h6" gutterBottom>
            Overall Score: {data.overallScore?.toFixed(2) ?? 'n/a'}
          </Typography>
          <Tabs value={tab} onChange={(_,v)=>setTab(v)} sx={{ mb: 2 }}>
            {(['extraction','scoring','decision'] as const).map((cat, i) => (
              <Tab key={cat} label={cat} value={i} />
            ))}
          </Tabs>
          {(['extraction','scoring','decision'] as const).map((cat,i) => (
            tab===i && (
            <Box key={cat} sx={{ mb: 2 }}>
              <PromptDetailsTable data={(data as any)[cat] as any[]} onSelect={setHighlight} />
            </Box>)
          ))}
          <Box sx={{ mt: 2 }}>
            <PdfViewer url={pdfUrl} highlight={highlight} />
          </Box>
        </>
      )}
    </Box>
  );
}
