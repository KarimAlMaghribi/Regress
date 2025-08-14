import React, { useState } from 'react';
import { Box, Tabs, Tab, Typography } from '@mui/material';
import GenericResultTable from './GenericResultTable';
import PdfViewer from './PdfViewer';
import { PipelineRunResult, TextPosition } from '../types/pipeline';
import { enrichRunLog } from '../utils/enrichRunLog';

interface Props {
  run: PipelineRunResult;
  pdfUrl: string;
}

export default function RunDetails({ run, pdfUrl }: Props) {
  const [tab, setTab] = useState(0);
  const [highlight, setHighlight] = useState<TextPosition | null>(null);

  const meta = [
    { key: 'pipeline_id', value: (run as any).pipelineId ?? (run as any).pipeline_id ?? '—' },
    { key: 'pdf_id', value: (run as any).pdfId ?? (run as any).pdf_id ?? '—' },
    {
      key: 'overall_score',
      value:
        (run as any).overallScore?.toFixed?.(2) ??
        (run as any).overall_score?.toFixed?.(2) ??
        '—',
    },
    { key: 'extraction', value: run.extraction?.length ?? 0 },
    { key: 'scoring', value: run.scoring?.length ?? 0 },
    { key: 'decision', value: run.decision?.length ?? 0 },
    ...(run.timestamp ? [{ key: 'timestamp', value: run.timestamp }] : []),
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2 }}>
        {meta.map(m => (
          <Box key={m.key} sx={{ minWidth: 120 }}>
            <Typography variant="caption">{m.key}</Typography>
            <Typography variant="body2">{m.value}</Typography>
          </Box>
        ))}
      </Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        {(['extraction', 'scoring', 'decision'] as const).map((cat, i) => (
          <Tab key={cat} label={cat} value={i} />
        ))}
      </Tabs>
      {(['extraction', 'scoring', 'decision'] as const).map((cat, i) => (
        tab === i && (
          <Box key={cat} sx={{ mb: 2 }}>
            <GenericResultTable data={(run as any)[cat] ?? []} onSelect={setHighlight} />
          </Box>
        )
      ))}
      <Box sx={{ mt: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Run-Log
        </Typography>
        <GenericResultTable
          data={enrichRunLog(run.log ?? []) as any}
          onSelect={setHighlight}
          preferredOrder={['seq_no', 'prompt_type', 'decision_key', 'route', 'prompt_text']}
        />
      </Box>
      <Box sx={{ mt: 2 }}>
        <PdfViewer url={pdfUrl} highlight={highlight} />
      </Box>
    </Box>
  );
}
