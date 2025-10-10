import React, {useMemo, useRef, useState} from 'react';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Divider,
  IconButton,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography
} from '@mui/material';
import LaunchIcon from '@mui/icons-material/Launch';

import PdfViewer from './PdfViewer';
import {PipelineRunResult, TextPosition} from '../types/pipeline';
import {FinalHeader} from './final/FinalPills';

function normalizeRun(run: any): any {
  if (!run || typeof run !== 'object') return run;
  const n: any = {...run};
  if (n.overall_score === undefined && typeof n.overallScore === 'number') n.overall_score = n.overallScore;
  if (!n.decisions && n.final_decisions && typeof n.final_decisions === 'object') n.decisions = n.final_decisions;
  if (n.extracted == null) n.extracted = {};
  if (n.decisions == null) n.decisions = {};
  return n;
}

function clamp01(x: any): number | null {
  if (typeof x !== 'number' || !isFinite(x)) return null;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function ConfidenceBar({value}: { value?: number | null }) {
  const v = clamp01(value ?? null);
  if (v == null) return <Typography variant="body2">—</Typography>;
  return (
      <Stack direction="row" alignItems="center" gap={1} sx={{minWidth: 140}}>
        <Box sx={{flex: 1}}>
          <LinearProgress variant="determinate" value={v * 100}/>
        </Box>
        <Typography variant="caption" sx={{width: 36, textAlign: 'right'}}>
          {(v * 100).toFixed(0)}%
        </Typography>
      </Stack>
  );
}

function fmt(val: any) {
  if (val == null) return '—';
  if (typeof val === 'number') return Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(val);
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function formatDuration(start: string, end: string): string {
  const startTime = new Date(start);
  const endTime = new Date(end);
  const diff = endTime.getTime() - startTime.getTime();
  const seconds = Math.floor(diff / 1000);
  const ms = diff % 1000;
  return `${seconds}s ${ms}ms`;
}

interface Props {
  run: PipelineRunResult;
  pdfUrl: string;
}

export default function RunDetails({run: rawRun, pdfUrl}: Props) {
  const run: any = useMemo(() => normalizeRun(rawRun), [rawRun]);
  const [highlight, setHighlight] = useState<TextPosition | null>(null);
  const stepRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const extractedEntries = useMemo(() => Object.entries(run.extracted ?? {}), [run.extracted]);
  const scoringArray = Array.isArray(run.scoring) ? run.scoring : [];

  const computedOverall: number | null = useMemo(() => {
    if (typeof run.overall_score === 'number') return clamp01(run.overall_score)!;
    const list: Array<any> = scoringArray;
    if (!list.length) return null;
    let num = 0;
    let den = 0;
    for (const s of list) {
      const w = typeof s?.confidence === 'number' ? s.confidence : 1;
      den += w;
      if (s?.result === true) num += w;
    }
    if (den <= 0) return null;
    return clamp01(num / den);
  }, [run.overall_score, scoringArray]);

  const meta = [
    ...(run.pipeline_id ? [{key: 'pipeline_id', value: String(run.pipeline_id)}] : []),
    ...(run.pdf_id != null ? [{key: 'pdf_id', value: String(run.pdf_id)}] : []),
    ...(run.started_at && run.finished_at
        ? [{key: 'Laufzeit', value: formatDuration(run.started_at, run.finished_at)}] : []),
    ...(computedOverall != null ? [{key: 'overall_score', value: computedOverall.toFixed(2)}] : []),
  ];

  const scrollToStep = (stepId: string) => {
    const el = stepRefs.current[stepId];
    if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
  };

  return (
      <Box>
        <Box sx={{display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2}}>
          {meta.map(m => (
              <Box key={m.key} sx={{minWidth: 120}}>
                <Typography variant="caption">{m.key}</Typography>
                <Typography variant="body2">{m.value}</Typography>
              </Box>
          ))}
        </Box>

        <FinalHeader extracted={run.extracted} scores={run.scores} decisions={run.decisions}/>

        {/* Schritte & Versuche */}
        {Array.isArray(run.log) && run.log.length > 0 && (
            <Card variant="outlined" sx={{mt: 3}}>
              <CardHeader title="Schritte & Versuche" subheader="Abarbeitung der Pipeline"/>
              <CardContent>
                <Stack spacing={2} divider={<Divider/>}>
                  {run.log.map((step: any) => {
                    const stepId = step.step_id ?? step.seq_no;
                    const refKey = String(stepId);
                    return (
                        <Box key={refKey} ref={el => (stepRefs.current[refKey] = el)}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Tooltip title={step.prompt_text ?? ''}>
                              <Chip
                                  label={step.prompt_text ?? step.prompt_type}
                                  size="small"
                                  onClick={() => scrollToStep(refKey)}
                                  sx={{maxWidth: 300}}
                              />
                            </Tooltip>
                            <Typography variant="body2" noWrap>
                              {fmt(step.result?.value ?? step.result?.final_value ?? '—')}
                            </Typography>
                          </Stack>
                        </Box>
                    );
                  })}
                </Stack>
              </CardContent>
            </Card>
        )}

        {extractedEntries.length > 0 && (
            <Card variant="outlined" sx={{mt: 3}}>
              <CardHeader title="Finale Extraktion"/>
              <CardContent>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Feld</TableCell>
                      <TableCell>Wert</TableCell>
                      <TableCell width={200}>Confidence</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {extractedEntries.map(([k, v]: any) => (
                        <TableRow key={k}>
                          <TableCell>
                            <Tooltip title={k}>
                              <Typography noWrap
                                          sx={{maxWidth: 280}}>{k.replace(/_/g, ' ')}</Typography>
                            </Tooltip>
                          </TableCell>
                          <TableCell>{fmt(v?.value)}</TableCell>
                          <TableCell><ConfidenceBar value={v?.confidence}/></TableCell>
                        </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
        )}

        {scoringArray.length > 0 && (
            <Card variant="outlined" sx={{mt: 3}}>
              <CardHeader
                  title="Scoring (final)"
                  subheader="Ja/Nein-Ergebnisse je Prompt"
                  action={<ConfidenceBar value={computedOverall}/>}
              />
              <CardContent>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Prompt</TableCell>
                      <TableCell>Label</TableCell>
                      <TableCell>Confidence</TableCell>
                      <TableCell>Votes</TableCell>
                      <TableCell>Begründung</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {scoringArray.map((v: any, idx: number) => (
                        <TableRow key={idx}>
                          <TableCell>
                            <Tooltip title={v.prompt_text ?? ''}>
                              <Typography noWrap
                                          sx={{maxWidth: 280}}>{v.prompt_text ?? `Prompt ${v.prompt_id}`}</Typography>
                            </Tooltip>
                          </TableCell>
                          <TableCell><Chip label={v.label} size="small"/></TableCell>
                          <TableCell><ConfidenceBar value={v.confidence}/></TableCell>
                          <TableCell>{(v.votes_true ?? 0)} / {(v.votes_false ?? 0)}</TableCell>
                          <TableCell>{v.explanation ?? '—'}</TableCell>
                        </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
        )}

        <Box sx={{mt: 4}}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{mb: 1}}>
            <Typography variant="subtitle2">PDF</Typography>
            {pdfUrl && (
                <Tooltip title="PDF in neuem Tab öffnen">
                  <IconButton size="small"
                              onClick={() => window.open(pdfUrl, '_blank', 'noopener,noreferrer')}>
                    <LaunchIcon fontSize="small"/>
                  </IconButton>
                </Tooltip>
            )}
          </Stack>
          <PdfViewer url={pdfUrl} highlight={highlight}/>
        </Box>
      </Box>
  );
}
