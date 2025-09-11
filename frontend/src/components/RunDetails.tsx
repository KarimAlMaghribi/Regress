import React, { useState } from 'react';
import { Box, Tabs, Tab, Typography } from '@mui/material';
import GenericResultTable from './GenericResultTable';
import PdfViewer from './PdfViewer';
import { PipelineRunResult, TextPosition } from '../types/pipeline';
import { FinalHeader } from './final/FinalPills';

interface Props {
  run: PipelineRunResult;
  pdfUrl: string;
}

export default function RunDetails({ run, pdfUrl }: Props) {
  const [tab, setTab] = useState(0);
  const [highlight, setHighlight] = useState<TextPosition | null>(null);

  const meta = [
    ...(run.pipeline_id ? [{ key: 'pipeline_id', value: String(run.pipeline_id) }] : []),
    ...(run.pdf_id != null ? [{ key: 'pdf_id', value: String(run.pdf_id) }] : []),
    ...(run.overall_score != null ? [{ key: 'overall_score', value: String(run.overall_score) }] : []),
    ...(run.timestamp ? [{ key: 'timestamp', value: run.timestamp }] : []),
  ];

  return (
      <Box>
        {/* Meta */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2 }}>
          {meta.map(m => (
              <Box key={m.key} sx={{ minWidth: 120 }}>
                <Typography variant="caption">{m.key}</Typography>
                <Typography variant="body2">{m.value}</Typography>
              </Box>
          ))}
        </Box>

        {/* Finale Übersicht */}
        <FinalHeader
            extracted={(run as any)?.extracted}
            scores={(run as any)?.scores}
            decisions={(run as any)?.decisions}
        />

        {/* Tabs */}
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
          {(['extraction', 'scoring', 'decision'] as const).map((cat, i) => (
              <Tab key={cat} label={cat} value={i} />
          ))}
        </Tabs>

        {/* Ergebnislisten */}
        {(['extraction', 'scoring', 'decision'] as const).map((cat, i) => (
            tab === i && (
                <Box key={cat} sx={{ mb: 2 }}>
                  <GenericResultTable data={(run as any)[cat] ?? []} onSelect={setHighlight} />
                </Box>
            )
        ))}

        {/* Run-Log */}
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Run-Log
          </Typography>
          <GenericResultTable
              data={run.log ?? [] as any}
              onSelect={setHighlight}
              preferredOrder={['seq_no', 'prompt_type', 'decision_key', 'route', 'prompt_text']}
          />
        </Box>

        {/* PDF-Viewer */}
        <Box sx={{ mt: 2 }}>
          <PdfViewer url={pdfUrl} highlight={highlight} />
        </Box>
      </Box>
  );
}
