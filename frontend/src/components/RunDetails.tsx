import React, { useMemo, useState } from 'react';
import {
  Box, Tabs, Tab, Typography,
  Card, CardHeader, CardContent,
  Chip, Stack, Table, TableHead, TableRow, TableCell, TableBody,
  Tooltip, LinearProgress, IconButton
} from '@mui/material';
import LaunchIcon from '@mui/icons-material/Launch';

import GenericResultTable from './GenericResultTable';
import PdfViewer from './PdfViewer';
import { PipelineRunResult, TextPosition } from '../types/pipeline';
import { FinalHeader } from './final/FinalPills';

function normalizeRun(run: any): any {
  if (!run || typeof run !== 'object') return run;
  const n: any = { ...run };
  if (n.overall_score === undefined && typeof n.overallScore === 'number') n.overall_score = n.overallScore;
  if (!n.decisions && n.final_decisions && typeof n.final_decisions === 'object') n.decisions = n.final_decisions;
  if (n.extracted == null) n.extracted = {};
  if (n.decisions == null) n.decisions = {};
  return n;
}

function clamp01(x: any): number | null {
  if (typeof x !== 'number' || !isFinite(x)) return null;
  if (x < 0) return 0; if (x > 1) return 1;
  return x;
}

function ConfidenceBar({ value }: { value?: number | null }) {
  const v = clamp01(value ?? null);
  if (v == null) return <Typography variant="body2">—</Typography>;
  return (
      <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 140 }}>
        <Box sx={{ flex: 1 }}>
          <LinearProgress variant="determinate" value={v * 100} />
        </Box>
        <Typography variant="caption" sx={{ width: 36, textAlign: 'right' }}>
          {(v * 100).toFixed(0)}%
        </Typography>
      </Stack>
  );
}

function fmt(val: any) {
  if (val == null) return '—';
  if (typeof val === 'number') return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(val);
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function toPosLike(obj: any): any | null {
  if (!obj || typeof obj !== 'object') return null;
  const page = obj.page ?? obj?.source?.page ?? null;
  const bbox = obj.bbox ?? obj?.source?.bbox ?? null;
  const quote = obj.quote ?? obj?.source?.quote ?? null;
  return { page, bbox, quote };
}

function EvidenceChip({ ev, onSelect }: { ev: any; onSelect: (p: TextPosition | null) => void }) {
  if (!ev || !ev.page) return <span>—</span>;
  const title = `${`Seite ${ev.page}`}${Array.isArray(ev.bbox) ? ` • BBox: ${ev.bbox.join(',')}` : ''}${ev.quote ? `\n${ev.quote}` : ''}`;
  return (
      <Tooltip title={title}>
        <Chip
            size="small"
            label={`Seite ${ev.page}`}
            clickable
            onClick={() => {
              const pos: TextPosition = {
                page: ev.page as number,
                bbox: (Array.isArray(ev.bbox) ? (ev.bbox as [number, number, number, number]) : [0, 0, 0, 0]),
                quote: ev.quote ?? undefined,
              };
              onSelect(pos);
            }}
        />
      </Tooltip>
  );
}

interface Props {
  run: PipelineRunResult;
  pdfUrl: string;
}

export default function RunDetails({ run: rawRun, pdfUrl }: Props) {
  const run: any = useMemo(() => normalizeRun(rawRun), [rawRun]);
  const [tab, setTab] = useState(0);
  const [highlight, setHighlight] = useState<TextPosition | null>(null);

  const extractedEntries = useMemo(() => Object.entries(run.extracted ?? {}), [run.extracted]);
  const decisionEntries = useMemo(() => Object.entries(run.decisions ?? {}), [run.decisions]);
  const scoringArray = Array.isArray(run.scoring) ? run.scoring : [];

  const computedOverall: number | null = useMemo(() => {
    if (typeof run.overall_score === 'number') return clamp01(run.overall_score)!;
    const list: Array<any> = scoringArray;
    if (!list.length) return null;
    let num = 0; let den = 0;
    for (const s of list) {
      const w = typeof s?.confidence === 'number' ? s.confidence : 1;
      den += w;
      if (s?.result === true) num += w;
    }
    if (den <= 0) return null;
    return clamp01(num / den);
  }, [run.overall_score, scoringArray]);

  const meta = [
    ...(run.pipeline_id ? [{ key: 'pipeline_id', value: String(run.pipeline_id) }] : []),
    ...(run.pdf_id != null ? [{ key: 'pdf_id', value: String(run.pdf_id) }] : []),
    ...(computedOverall != null ? [{ key: 'overall_score', value: computedOverall.toFixed(2) }] : []),
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

        <FinalHeader extracted={run.extracted} scores={run.scores} decisions={run.decisions} />

        {extractedEntries.length > 0 && (
            <Card variant="outlined" sx={{ mt: 2 }}>
              <CardHeader title="Finale Extraktion" />
              <CardContent>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Feld</TableCell>
                      <TableCell>Wert</TableCell>
                      <TableCell width={200}>Confidence</TableCell>
                      <TableCell>Stelle</TableCell>
                      <TableCell>Zitat</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {extractedEntries.map(([k, v]: any) => {
                      const ev = toPosLike(v);
                      return (
                          <TableRow key={k}>
                            <TableCell><Chip size="small" label={k} /></TableCell>
                            <TableCell>{fmt(v?.value)}</TableCell>
                            <TableCell><ConfidenceBar value={v?.confidence} /></TableCell>
                            <TableCell><EvidenceChip ev={ev} onSelect={setHighlight} /></TableCell>
                            <TableCell>{ev?.quote ? <Tooltip title={ev.quote}><Typography noWrap sx={{ maxWidth: 360 }}>{ev.quote}</Typography></Tooltip> : '—'}</TableCell>
                          </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
        )}

        {scoringArray.length > 0 && (
            <Card variant="outlined" sx={{ mt: 2 }}>
              <CardHeader
                  title="Scoring (final)"
                  subheader="Ja/Nein-Ergebnisse je Prompt"
                  action={<ConfidenceBar value={computedOverall} />}
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
                      <TableCell>Support</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {scoringArray.map((v: any, idx: number) => (
                        <TableRow key={idx}>
                          <TableCell>{v.prompt_text || `Prompt ${v.prompt_id}`}</TableCell>
                          <TableCell><Chip label={v.label} size="small" /></TableCell>
                          <TableCell><ConfidenceBar value={v.confidence} /></TableCell>
                          <TableCell>{(v.votes_true ?? 0)} / {(v.votes_false ?? 0)}</TableCell>
                          <TableCell>{v.explanation ?? '—'}</TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.5} flexWrap="wrap">
                              {(v.support ?? []).slice(0, 3).map((s: any, i: number) => (
                                  <EvidenceChip key={i} ev={s} onSelect={setHighlight} />
                              ))}
                            </Stack>
                          </TableCell>
                        </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
        )}

        {decisionEntries.length > 0 && (
            <Card variant="outlined" sx={{ mt: 2 }}>
              <CardHeader title="Decision (final)" subheader="Routenentscheidungen je Prompt" />
              <CardContent>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Decision-Key</TableCell>
                      <TableCell>Route</TableCell>
                      <TableCell>Answer</TableCell>
                      <TableCell width={200}>Confidence</TableCell>
                      <TableCell>Votes</TableCell>
                      <TableCell>Erklärung</TableCell>
                      <TableCell>Support</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {decisionEntries.map(([k, v]: any) => {
                      const support: any[] = Array.isArray(v?.support) ? v.support : [];
                      return (
                          <TableRow key={k}>
                            <TableCell><Chip size="small" label={k} /></TableCell>
                            <TableCell><Chip size="small" label={v?.route ?? '—'} /></TableCell>
                            <TableCell>{typeof v?.answer === 'boolean' ? <Chip size="small" color={v.answer ? 'success' : 'error'} label={v.answer ? 'Ja' : 'Nein'} /> : '—'}</TableCell>
                            <TableCell><ConfidenceBar value={v?.confidence} /></TableCell>
                            <TableCell>{(v?.votes_yes ?? v?.votes_true ?? 0)} / {(v?.votes_no ?? v?.votes_false ?? 0)}</TableCell>
                            <TableCell>{v?.explanation ?? '—'}</TableCell>
                            <TableCell>
                              <Stack direction="row" gap={0.5} flexWrap="wrap">
                                {support.length
                                    ? support.slice(0, 3).map((s, i) => (
                                        <EvidenceChip key={i} ev={toPosLike(s)} onSelect={setHighlight} />
                                    ))
                                    : '—'}
                              </Stack>
                            </TableCell>
                          </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
        )}

        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mt: 3, mb: 2 }}>
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
          <Typography variant="subtitle2" gutterBottom>Run-Log</Typography>
          <GenericResultTable
              data={run.log ?? [] as any}
              onSelect={setHighlight}
              preferredOrder={['seq_no', 'prompt_type', 'decision_key', 'route', 'prompt_text']}
          />
        </Box>

        <Box sx={{ mt: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <Typography variant="subtitle2">PDF</Typography>
            {pdfUrl && (
                <Tooltip title="PDF in neuem Tab öffnen">
                  <IconButton size="small" onClick={() => window.open(pdfUrl, '_blank', 'noopener,noreferrer')}>
                    <LaunchIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
            )}
          </Stack>
          <PdfViewer url={pdfUrl} highlight={highlight} />
        </Box>
      </Box>
  );
}
