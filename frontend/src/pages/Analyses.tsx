import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Tabs, Tab, Paper, Button, Typography,
  Table, TableHead, TableRow, TableCell, TableBody,
  Chip, Stack, Drawer, IconButton, FormControlLabel, Checkbox, Tooltip
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs, { Dayjs } from 'dayjs';
import { utils as XLSXUtils, writeFile } from 'xlsx';
import PageHeader from '../components/PageHeader';
import { PipelineRunResult } from '../types/pipeline';
import RunDetails from '../components/RunDetails';
import { FinalSnapshotCell } from '../components/final/FinalPills';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useNavigate } from 'react-router-dom';

declare global {
  interface Window { __ENV__?: any }
}

interface PromptCfg { text: string }

interface Entry {
  id: number; // analysis id
  pdfId: number;
  pdfUrl?: string;
  prompts: PromptCfg[];
  status: string;
  timestamp: string;
  result?: PipelineRunResult;
}

const LS_PREFIX = "run-view:";
function openDetailsInNewTab(entry: any) {
  const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = { run: entry.result, pdfUrl: entry.pdfUrl ?? "" };
  try {
    localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(payload));
  } catch {
  }
  window.open(`/run-view/${key}`, "_blank", "noopener,noreferrer");
}


/** Reihenfolge-Präferenzen für prominente Final-Felder (sofern vorhanden) */
const PREFERRED_KEYS = ['sender', 'iban', 'bic', 'totalAmount', 'amount', 'customerNumber', 'contract_valid'];

function getFinalExtractedKeys(e: Entry): string[] {

  const ex = (e.result as any)?.extracted || {};
  return Object.keys(ex);
}
function pickValueAndConf(obj: any, key: string): { value?: any; conf?: number } {

  const rec = obj?.[key];
  if (!rec) return {};
  return { value: rec.value, conf: typeof rec.confidence === 'number' ? rec.confidence : undefined };
}
/** Ermittelt eine geordnete Liste an Final-Feldern, die wir als Spalten zeigen (max 4) */
function computeFinalKeyOrder(items: Entry[], maxCols = 4): string[] {

  const freq = new Map<string, number>();
  for (const it of items) {
    for (const k of getFinalExtractedKeys(it)) {
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  // zuerst nach PREFERRED_KEYS, danach nach Häufigkeit
  const presentPreferred = PREFERRED_KEYS.filter(k => freq.has(k));
  const others = Array.from(freq.entries())
  .filter(([k]) => !presentPreferred.includes(k))
  .sort((a, b) => b[1] - a[1])
  .map(([k]) => k);
  const ordered = [...presentPreferred, ...others].slice(0, maxCols);

  return ordered;
}
export default function Analyses() {
  const navigate = useNavigate();

  const [tab, setTab] = useState(0);
  const [running, setRunning] = useState<Entry[]>([]);
  const [done, setDone] = useState<Entry[]>([]);
  const [start, setStart] = useState<Dayjs | null>(null);
  const [end, setEnd] = useState<Dayjs | null>(null);

  // NEW
  const [selected, setSelected] = useState<Entry | null>(null);
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
          if (Array.isArray(arr)) {
            prompts = arr.map((p: any) => ({ text: p.text ?? String(p) }));
          } else if (typeof arr === 'string') {
            prompts = [{ text: arr }];
          }
        } catch {
          if (d.prompt) prompts = [{ text: d.prompt }];
        }
        return {
          id: d.id,
          pdfId: d.pdf_id ?? d.pdfId ?? d.file_id ?? 0,
          pdfUrl: d.pdf_url ?? d.pdfUrl,
          prompts,
          status: d.status ?? '',
          timestamp: d.timestamp ?? d.created_at ?? '',
          result: d.result as PipelineRunResult | undefined,
        };
      };
      const r = runningData.map(map);
      const c = doneData.map(map).sort((a, b) => dayjs(b.timestamp).valueOf() - dayjs(a.timestamp).valueOf());
      setRunning(r);
      setDone(c);
    })
    .catch(e => console.error('load analyses', e));
  };

  useEffect(load, []);

  // Filter: Zeit
  const filteredDoneByDate = useMemo(() => {
    return done.filter(e => {
      const ts = dayjs(e.timestamp);
      if (start && ts.isBefore(start, 'day')) return false;
      if (end && ts.isAfter(end, 'day')) return false;
      return true;
    });
  }, [done, start, end]);

  // Filter: nur unsichere (mind. ein Final-Field < 0.6)
  const filteredDone = useMemo(() => {
    if (!onlyLowConf) return filteredDoneByDate;
    return filteredDoneByDate.filter(e => {
      const ex = (e.result as any)?.extracted || {};
      const anyLow = Object.values(ex).some((v: any) => (v?.confidence ?? 1) < 0.6);
      return anyLow;
    });
  }, [filteredDoneByDate, onlyLowConf]);

  // Dynamische Final-Feldspalten (max 4)
  const finalCols = useMemo(() => computeFinalKeyOrder(filteredDone, 4), [filteredDone]);

  const exportExcel = () => {
    const rows = filteredDone.map(e => {
      const ex = (e.result as any)?.extracted ?? {};
      const dec = (e.result as any)?.decisions ?? {};
      const flatEx = Object.fromEntries(
          Object.entries(ex).map(([k, v]: any) => [`final.${k}`, v?.value ?? ''])
      );
      const flatDec = Object.fromEntries(
          Object.entries(dec).map(([k, v]: any) => [`decision.${k}`, `${v.route} (${(v.confidence ?? 0).toFixed(2)})`])
      );
      return {
        pdf: `PDF ${e.pdfId}`,
        prompt: e.prompts.map(p => p.text).join(' | '),
        overallScore: e.result?.overallScore ?? '',
        ...flatEx,
        ...flatDec,
      };
    });
    const ws = XLSXUtils.json_to_sheet(rows);
    const wb = XLSXUtils.book_new();
    XLSXUtils.book_append_sheet(wb, ws, 'Analysen');
    writeFile(wb, 'analysen.xlsx');
  };

  const renderList = (items: Entry[], finished: boolean) => (
      <Paper sx={{ p: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name der PDF</TableCell>
              <TableCell>Prompts</TableCell>
              {finished && <TableCell>Score</TableCell>}
              {finished && <TableCell>Route</TableCell>}

              {/* Dynamische Final-Feldspalten */}
              {finished && finalCols.map(col => (
                  <TableCell key={`col-${col}`}>{col}</TableCell>
              ))}

              {finished && <TableCell>Final</TableCell>}
              {finished && <TableCell align="right">Details</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map(e => {
              const ex = (e.result as any)?.extracted || {};
              return (
                  <TableRow
                      key={e.id}
                      hover
                      onClick={() => finished && setSelected(e)}
                      sx={{ cursor: finished ? 'pointer' : 'default' }}
                  >
                    <TableCell>{`PDF ${e.pdfId}`}</TableCell>
                    <TableCell>
                      {e.prompts.map((p, i) => (
                          <Chip key={`p-${i}`} label={p.text} size="small" sx={{ mr: 0.5, mb: 0.5 }} />
                      ))}
                      {finished && e.result?.log?.filter(l => l.prompt_type === 'DecisionPrompt').map(d => (
                          <Chip key={d.seq_no} label={`${d.seq_no}: ${d.decision_key}`} size="small" sx={{ ml: 0.5 }} />
                      ))}
                    </TableCell>

                    {finished && <TableCell>{e.result?.overallScore?.toFixed(2) ?? ''}</TableCell>}
                    {finished && <TableCell>{e.result?.log?.map(l => l.route ?? 'root').join(' › ')}</TableCell>}

                    {/* Dynamische Final-Feldspalten: Wert + Confidence */}
                    {finished && finalCols.map(col => {
                      const val = (ex as any)?.[col]?.value;
                      const conf = (ex as any)?.[col]?.confidence;
                      return (
                          <TableCell key={`cell-${e.id}-${col}`}>
                            {val !== undefined ? (
                                <Tooltip title={typeof conf === 'number' ? `Confidence: ${(conf * 100).toFixed(0)}%` : ''}>
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
                        <TableCell>
                          <FinalSnapshotCell result={e.result} />
                        </TableCell>
                    )}

                    {finished && (
                        <TableCell align="right">
                          <IconButton
                              size="small"
                              onClick={(ev) => { ev.stopPropagation(); openDetailsInNewTab(e); }}
                              title="Details"
                          >
                            <VisibilityIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                    )}
                  </TableRow>
              );
            })}
            {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={finished ? (6 + finalCols.length) : 2} align="center">
                    <Typography>Keine Einträge</Typography>
                  </TableCell>
                </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
  );

  return (
      <Box>
        <PageHeader
            title="Analysen"
            breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Analysen' }]}
            actions={<Button variant="contained" onClick={load}>Reload</Button>}
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
                    label="Nur unsichere"
                />
                <Button variant="outlined" onClick={exportExcel}>Excel Export</Button>
              </Stack>
              {renderList(filteredDone, true)}
            </Box>
        )}

        {/* Details-Drawer */}
        <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)}>
          {selected?.result && (
              <Box sx={{ width: { xs: 320, sm: 460, md: 640 }, p: 2 }}>
                <RunDetails run={selected.result} pdfUrl={selected.pdfUrl ?? ''} />
              </Box>
          )}
        </Drawer>
      </Box>
  );
}
