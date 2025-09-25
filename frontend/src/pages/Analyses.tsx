import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Tabs, Tab, Paper, Button, Typography,
  Table, TableHead, TableRow, TableCell, TableBody,
  Stack, IconButton, FormControlLabel, Checkbox, Tooltip
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs, { Dayjs } from 'dayjs';
import { utils as XLSXUtils, writeFile } from 'xlsx';
import PageHeader from '../components/PageHeader';
import { PipelineRunResult } from '../types/pipeline';
import VisibilityIcon from '@mui/icons-material/Visibility';

declare global { interface Window { __ENV__?: any } }

interface PromptCfg { text: string }
interface Entry {
  id: number;           // Analyse-ID (History)
  pdfId: number;
  pdfUrl?: string;
  prompts: PromptCfg[]; // verbleibt im Typ, wird jedoch nicht mehr angezeigt
  status: string;
  timestamp: string;
  result?: PipelineRunResult | any;
  pipelineId?: string;
  pipelineName?: string;
}

const PREFERRED_KEYS = ['sender', 'iban', 'bic', 'totalAmount', 'amount', 'customerNumber', 'contract_valid'];
const LS_PREFIX = 'run-view:';

/* -------- Hilfsfunktionen -------- */

function getPipelineApiBase(): string {
  const w = (window as any);
  return w.__ENV__?.PIPELINE_API_URL || import.meta.env?.VITE_PIPELINE_API_URL || '/pl';
}

function normalizeRunShape(run: any | undefined | null): any {
  if (!run || typeof run !== 'object') return run;
  const n: any = { ...run };
  if (n.overall_score === undefined && typeof n.overallScore === 'number') n.overall_score = n.overallScore;
  if (!n.scores && n.final_scores && typeof n.final_scores === 'object') n.scores = n.final_scores;
  if (!n.decisions && n.final_decisions && typeof n.final_decisions === 'object') n.decisions = n.final_decisions;
  if (n.extracted == null) n.extracted = {};
  if (n.scores == null) n.scores = {};
  if (n.decisions == null) n.decisions = {};
  if (!Array.isArray(n.log) && n.log != null) n.log = [];
  return n;
}

function getFinalExtractedKeys(e: Entry): string[] {
  const ex = (normalizeRunShape(e.result))?.extracted || {};
  return Object.keys(ex);
}

function computeFinalKeyOrder(items: Entry[], maxCols = 4): string[] {
  const freq = new Map<string, number>();
  for (const it of items) for (const k of getFinalExtractedKeys(it)) freq.set(k, (freq.get(k) ?? 0) + 1);
  const presentPreferred = PREFERRED_KEYS.filter(k => freq.has(k));
  const others = Array.from(freq.entries())
  .filter(([k]) => !presentPreferred.includes(k))
  .sort((a, b) => b[1] - a[1])
  .map(([k]) => k);
  return [...presentPreferred, ...others].slice(0, maxCols);
}

const KEY_LABELS: Record<string, string> = {
  sender: 'Rechnungssteller',
  iban: 'IBAN',
  bic: 'BIC',
  totalAmount: 'Brutto-Gesamtsumme',
  amount: 'Betrag',
  customerNumber: 'Kundennummer',
  contract_valid: 'Vertrag gültig',
};

function translateKeyHeader(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/* -------- Backend-Auflösung (run_id & Konsolidat) -------- */

/** Versucht eine run_id über mehrere Endpunkte zu ermitteln */
async function resolveRunIdIfMissing(normalized: any, entry: Entry): Promise<string | undefined> {
  const direct = normalized?.run_id ?? normalized?.id ?? normalized?.runId;
  if (typeof direct === 'string') return direct;

  const api = getPipelineApiBase();
  const pdfId = normalized?.pdf_id ?? entry.pdfId;
  const pipelineId = normalized?.pipeline_id ?? normalized?.pipelineId ?? entry.pipelineId;
  if (!pdfId || !pipelineId) return undefined;

  const candidates = [
    `${api}/runs/latest?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}`,
    `${api}/runs?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=1`,
    `${api}/runs/last?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}`,
  ];

  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const json = await r.json();
      if (json && typeof json === 'object') {
        if (typeof json.run_id === 'string') return json.run_id;
        if (typeof json.id === 'string') return json.id;
        if (Array.isArray(json) && json[0]) {
          const first = json[0];
          if (typeof first?.run_id === 'string') return first.run_id;
          if (typeof first?.id === 'string') return first.id;
        }
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

/** Holt direkt ein konsolidiertes DTO über pdf_id + pipeline_id */
async function fetchConsolidatedRun(normalized: any, entry: Entry): Promise<any | undefined> {
  const api = getPipelineApiBase();
  const pdfId = normalized?.pdf_id ?? entry.pdfId;
  const pipelineId = normalized?.pipeline_id ?? normalized?.pipelineId ?? entry.pipelineId;
  if (!pdfId || !pipelineId) return undefined;

  const candidates = [
    `${api}/runs/full?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=1`,
    `${api}/runs?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=1`,
  ];

  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const json = await r.json();
      if (json && typeof json === 'object') {
        if (json.extracted || json.scores || json.decisions) return normalizeRunShape(json);
        if (Array.isArray(json) && json.length > 0) {
          const first = json[0];
          if (first && typeof first === 'object') return normalizeRunShape(first);
        }
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

/* -------- Details in neuem Tab öffnen -------- */

async function openDetailsInNewTab(entry: Entry) {
  const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const normalized = normalizeRunShape(entry?.result) ?? null;

  const toNum = (v: any): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  // pdfId aus Entry/Result/Normalized ableiten
  let pdfId: number | undefined = (() => {
    const candidates = [
      entry?.pdfId,
      normalized?.pdf_id,
      normalized?.pdfId,
      entry?.result?.pdf_id,
      entry?.result?.pdfId,
    ];
    for (const c of candidates) {
      const n = toNum(c);
      if (n != null) return n;
    }
    return undefined;
  })();

  // Initial-Payload (für Sofort-Render) inkl. pdfId falls vorhanden
  let payload: any = { run: normalized, pdfUrl: entry?.pdfUrl ?? '' };
  if (pdfId != null) payload.pdfId = pdfId;

  try {
    localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(payload));
  } catch (e) {
    console.warn('Konnte localStorage nicht schreiben:', e);
  }

  // 1) run_id beschaffen (bevorzugt)
  let runId: string | undefined;
  try {
    runId = await resolveRunIdIfMissing(normalized, entry);
  } catch { /* ignore */ }

  // 2) Falls keine run_id & keine Finals → konsolidiertes DTO ziehen und Payload ersetzen
  const hasFinals =
      !!normalized &&
      typeof normalized === 'object' &&
      ((normalized.extracted && Object.keys(normalized.extracted).length) ||
          (normalized.scores && Object.keys(normalized.scores).length) ||
          (normalized.decisions && Object.keys(normalized.decisions).length));

  if (!runId && !hasFinals) {
    try {
      const finalRun = await fetchConsolidatedRun(normalized, entry);
      if (
          finalRun &&
          ((finalRun.extracted && Object.keys(finalRun.extracted).length) ||
              (finalRun.scores && Object.keys(finalRun.scores).length) ||
              (finalRun.decisions && Object.keys(finalRun.decisions).length))
      ) {
        // pdfId ggf. aus finalRun aktualisieren
        const candidate = toNum(finalRun?.pdf_id ?? finalRun?.pdfId);
        if (candidate != null) pdfId = candidate;

        payload = { run: finalRun, pdfUrl: entry?.pdfUrl ?? '' };
        if (pdfId != null) payload.pdfId = pdfId;

        try {
          localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(payload));
        } catch (e) {
          console.warn('Konnte localStorage nicht schreiben (finalRun):', e);
        }

        // falls API eine id/run_id liefert, an die URL hängen
        runId = finalRun?.run_id ?? finalRun?.id ?? runId;
      }
    } catch { /* ignore */ }
  }

  // Query-Params bauen (pdf_id nur wenn valide)
  const qp = new URLSearchParams();
  if (pdfId != null) qp.set('pdf_id', String(pdfId));
  if (entry?.pdfUrl) qp.set('pdf_url', entry.pdfUrl);
  if (runId) qp.set('run_id', runId);

  const url = `/run-view/${key}` + (qp.toString() ? `?${qp.toString()}` : '');
  window.open(url, '_blank', 'noopener,noreferrer');
}

function getPipelineLabel(entry: Entry): string {
  const r = normalizeRunShape(entry.result);
  const name = entry.pipelineName ?? r?.pipeline_name ?? r?.pipelineName ?? r?.pipeline?.name;
  const id = entry.pipelineId ?? r?.pipeline_id ?? r?.pipelineId;
  return name ?? (id ? `ID ${id}` : '—');
}

/* -------- Seitenkomponente -------- */

export default function Analyses() {
  const [tab, setTab] = useState(0);
  const [running, setRunning] = useState<Entry[]>([]);
  const [done, setDone] = useState<Entry[]>([]);
  const [start, setStart] = useState<Dayjs | null>(null);
  const [end, setEnd] = useState<Dayjs | null>(null);
  const [onlyLowConf, setOnlyLowConf] = useState(false);

  const load = () => {
    const base =
        (window as any).__ENV__?.HISTORY_URL ||
        import.meta.env.VITE_HISTORY_URL ||
        '/hist';

    Promise.all([
      fetch(`${base}/analyses?status=running`).then(r => r.json()),
      fetch(`${base}/analyses?status=completed`).then(r => r.json()),
    ])
    .then(([runningData, doneData]: [any[], any[]]) => {
      const map = (d: any): Entry => {
        let prompts: PromptCfg[] = [];
        try {
          const arr = JSON.parse(d.prompt ?? '');
          if (Array.isArray(arr)) prompts = arr.map((p: any) => ({ text: p.text ?? String(p) }));
          else if (typeof arr === 'string') prompts = [{ text: arr }];
        } catch { if (d.prompt) prompts = [{ text: d.prompt }]; }

        const rawResult = d.result ?? d.run ?? null;
        const normalized = normalizeRunShape(rawResult);

        // Falls History bereits run_id liefert: im Result ablegen (hilft dem opener)
        const withRunId = normalized ? { ...normalized } : normalized;
        if (withRunId && !withRunId.run_id && (d.run_id || d.runId)) {
          withRunId.run_id = d.run_id ?? d.runId;
        }

        const pipelineId = withRunId?.pipeline_id ?? withRunId?.pipelineId ?? d.pipeline_id ?? d.pipelineId ?? d?.pipeline?.id;
        const pipelineName = withRunId?.pipeline_name ?? withRunId?.pipelineName ?? d.pipeline_name ?? d.pipelineName ?? d?.pipeline?.name;

        return {
          id: d.id,
          pdfId: d.pdf_id ?? d.pdfId ?? d.file_id ?? 0,
          pdfUrl: d.pdf_url ?? d.pdfUrl,
          prompts,
          status: d.status ?? '',
          timestamp: d.timestamp ?? d.created_at ?? '',
          result: withRunId,
          pipelineId,
          pipelineName,
        };
      };

      const r = runningData.map(map);
      const c = doneData.map(map).sort((a, b) => dayjs(b.timestamp).valueOf() - dayjs(a.timestamp).valueOf());
      setRunning(r);
      setDone(c);
    })
    .catch(e => console.error('Analysen laden', e));
  };

  useEffect(load, []);

  const filteredDoneByDate = useMemo(() => {
    return done.filter(e => {
      const ts = dayjs(e.timestamp);
      if (start && ts.isBefore(start, 'day')) return false;
      if (end && ts.isAfter(end, 'day')) return false;
      return true;
    });
  }, [done, start, end]);

  const filteredDone = useMemo(() => {
    if (!onlyLowConf) return filteredDoneByDate;
    return filteredDoneByDate.filter(e => {
      const ex = (normalizeRunShape(e.result))?.extracted || {};
      return Object.values(ex).some((v: any) => (v?.confidence ?? 1) < 0.6);
    });
  }, [filteredDoneByDate, onlyLowConf]);

  const finalCols = useMemo(() => computeFinalKeyOrder(filteredDone, 4), [filteredDone]);

  const exportExcel = () => {
    const rows = filteredDone.map(e => {
      const run = normalizeRunShape(e.result);
      const ex = run?.extracted ?? {};
      const flatEx = Object.fromEntries(
          Object.entries(ex).map(([k, v]: any) => [`final.${k}`, v?.value ?? ''])
      );
      return {
        pdf: `PDF ${e.pdfId}`,
        pipeline: getPipelineLabel(e),
        gesamtscore: run?.overall_score ?? '',
        ...flatEx,
      } as Record<string, any>;
    });
    const ws = XLSXUtils.json_to_sheet(rows);
    const wb = XLSXUtils.book_new();
    XLSXUtils.book_append_sheet(wb, ws, 'Analysen');
    writeFile(wb, 'analysen.xlsx');
  };

  const renderList = (items: Entry[], finished: boolean) => {
    const emptyColSpan = finished ? (1 /* PDF */ + 1 /* Pipeline */ + 1 /* Score */ + finalCols.length + 1 /* Details */) : (1 /* PDF */ + 1 /* Pipeline */);
    return (
        <Paper sx={{ p: 2 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>PDF</TableCell>
                <TableCell>Pipeline</TableCell>
                {finished && <TableCell>Gesamtscore</TableCell>}
                {finished && finalCols.map(col => (
                    <TableCell key={`col-${col}`}>{translateKeyHeader(col)}</TableCell>
                ))}
                {finished && <TableCell align="right">Details</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map(e => {
                const run = normalizeRunShape(e.result);
                const ex = run?.extracted || {};
                return (
                    <TableRow
                        key={e.id}
                        hover
                        onClick={() => { if (finished) void openDetailsInNewTab(e); }}
                        sx={{ cursor: finished ? 'pointer' : 'default' }}
                    >
                      <TableCell>{`PDF ${e.pdfId}`}</TableCell>
                      <TableCell>{getPipelineLabel(e)}</TableCell>

                      {finished && (
                          <TableCell>{typeof run?.overall_score === 'number' ? run.overall_score.toFixed(2) : ''}</TableCell>
                      )}

                      {finished && finalCols.map(col => {
                        const val = (ex as any)?.[col]?.value;
                        const conf = (ex as any)?.[col]?.confidence;
                        return (
                            <TableCell key={`cell-${e.id}-${col}`}>
                              {val !== undefined ? (
                                  <Tooltip title={typeof conf === 'number' ? `Konfidenz: ${(conf * 100).toFixed(0)}%` : ''}>
                            <span>
                              {String(val)}
                              {typeof conf === 'number' && (
                                  <Typography component="span" variant="caption" sx={{ ml: 0.5, opacity: 0.7 }}>
                                    ({conf.toFixed(2)})
                                  </Typography>
                              )}
                            </span>
                                  </Tooltip>
                              ) : '—'}
                            </TableCell>
                        );
                      })}

                      {finished && (
                          <TableCell align="right">
                            <IconButton size="small" onClick={(ev) => { ev.stopPropagation(); void openDetailsInNewTab(e); }} title="Details anzeigen">
                              <VisibilityIcon fontSize="small" />
                            </IconButton>
                          </TableCell>
                      )}
                    </TableRow>
                );
              })}
              {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={emptyColSpan} align="center">
                      <Typography>Keine Einträge</Typography>
                    </TableCell>
                  </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
    );
  };

  return (
      <Box>
        <PageHeader
            title="Analysen"
            breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Analysen' }]}
            actions={<Button variant="contained" onClick={load}>Neu laden</Button>}
        />

        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label={`Laufend (${running.length})`} />
          <Tab label={`Abgeschlossen (${done.length})`} />
        </Tabs>

        {tab === 0 ? (
            renderList(running, false)
        ) : (
            <Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2, alignItems: 'center' }}>
                <DatePicker label="Start" value={start} onChange={d => setStart(d)} slotProps={{ textField: { size: 'small' } }} />
                <DatePicker label="Ende" value={end} onChange={d => setEnd(d)} slotProps={{ textField: { size: 'small' } }} />
                <FormControlLabel
                    control={<Checkbox checked={onlyLowConf} onChange={(e) => setOnlyLowConf(e.target.checked)} />}
                    label="Nur unsichere Werte"
                />
                <Button variant="outlined" onClick={exportExcel}>Excel‑Export</Button>
              </Stack>
              {renderList(filteredDone, true)}
            </Box>
        )}
      </Box>
  );
}
