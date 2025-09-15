import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Box, Card, CardContent, CardHeader, Chip, CircularProgress, Container,
  Grid, IconButton, LinearProgress, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, Tooltip, Typography, Accordion, AccordionSummary, AccordionDetails, Alert
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type { PipelineRunResult } from "../types/pipeline";

type TextPosition = { page: number; bbox: number[]; quote?: string | null };
type PromptType = "ExtractionPrompt" | "ScoringPrompt" | "DecisionPrompt";

type PromptResult = {
  prompt_id: number;
  prompt_type: PromptType;
  prompt_text: string;
  value?: any | null;
  boolean?: boolean | null;
  route?: string | null;
  weight?: number | null;
  source?: TextPosition | null;
  openai_raw?: string;
  json_key?: string | null;
  error?: string | null;
};

type ScoringResult = {
  prompt_id: number;
  result: boolean;
  source: TextPosition;
  explanation: string;
};

const CONF_WARN = 0.6;
const LS_PREFIX = "run-view:";

/** API-Basis (nur genutzt, wenn ?run_id=…) */
function getAPIBase(): string {
  const w = (window as any);
  return w.__ENV__?.PIPELINE_API_URL || import.meta.env?.VITE_PIPELINE_API_URL || "/pl";
}

export default function RunDetailsPage() {
  const { key } = useParams<{ key: string }>();
  const [sp] = useSearchParams();
  const runId = sp.get("run_id") || undefined;

  const [data, setData] = useState<PipelineRunResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const loadFromLocalStorage = React.useCallback(() => {
    if (!key) return false;
    const raw = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.run) {
        setData(parsed.run as PipelineRunResult);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }, [key]);

  const fetchRunById = React.useCallback(async () => {
    if (!runId) return false;
    setErr(null);
    try {
      const API = getAPIBase();
      const res = await fetch(`${API}/runs/${runId}`, { headers: { Accept: "application/json" } });
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const text = await res.text();
        throw new Error(`Expected JSON, got ${ct}\n${text.slice(0,180)}…`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PipelineRunResult;
      setData(json);
      return true;
    } catch (e: any) {
      setErr(e?.message ?? "Fehler beim Laden");
      return false;
    }
  }, [runId]);

  useEffect(() => {
    setLoading(true);
    const ok = loadFromLocalStorage();
    if (!ok) {
      if (runId) {
        fetchRunById().finally(() => setLoading(false));
      } else {
        setErr("Keine Daten gefunden (weder localStorage noch run_id). Bitte über die Liste erneut öffnen.");
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
  }, [loadFromLocalStorage, fetchRunById, runId]);

  const pdfUrl = useMemo(() => {
    if (!key) return "";
    try {
      const raw = localStorage.getItem(`${LS_PREFIX}${key}`);
      if (!raw) return "";
      const parsed = JSON.parse(raw);
      return parsed?.pdfUrl || "";
    } catch { return ""; }
  }, [key]);

  if (loading) {
    return (
        <Container maxWidth="xl" sx={{ py: 3 }}>
          <Stack direction="row" alignItems="center" gap={1}>
            <CircularProgress size={22} /> <Typography>Lade Details…</Typography>
          </Stack>
        </Container>
    );
  }
  if (err) {
    return (
        <Container maxWidth="xl" sx={{ py: 3 }}>
          <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>
          <Typography variant="body2" color="text.secondary">
            Tipp: Öffne die Details aus der Liste erneut – oder rufe diese Seite mit <code>?run_id=&lt;UUID&gt;</code> auf.
          </Typography>
        </Container>
    );
  }
  if (!data) return null;

  return (
      <Container maxWidth="xl" sx={{ py: 3 }}>
        {/* Header */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h5">Run-Details</Typography>
            <Typography variant="body2" color="text.secondary">
              Pipeline: {String((data as any).pipeline_id)} • PDF-ID: {data.pdf_id} {typeof data.overall_score === "number" ? `• Overall: ${data.overall_score?.toFixed(2)}` : ""}
            </Typography>
          </Box>
          <Stack direction="row" gap={1}>
            {pdfUrl && (
                <Tooltip title="PDF öffnen">
                  <IconButton size="small" onClick={() => window.open(pdfUrl, "_blank")}>
                    <OpenInNewIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
            )}
            <IconButton onClick={() => window.location.reload()} title="Neu laden"><RefreshIcon /></IconButton>
          </Stack>
        </Stack>

        <Grid container spacing={2}>
          {/* Final Results */}
          <Grid item xs={12} md={8}>
            <FinalExtractionCard extracted={data.extracted} />
            <FinalScoringCard scores={(data as any).scores} />
            <FinalDecisionCard decisions={(data as any).decisions} />
          </Grid>

          {/* Hinweise / Meta */}
          <Grid item xs={12} md={4}>
            <HintsCard data={data} />
          </Grid>

          {/* Drilldown */}
          <Grid item xs={12}>
            <PromptDrilldown data={data} />
          </Grid>
        </Grid>
      </Container>
  );
}

/* ---------- Final Cards ---------- */

function FinalExtractionCard({ extracted }: { extracted?: PipelineRunResult["extracted"] }) {
  const entries = useMemo(() => Object.entries(extracted ?? {}), [extracted]);
  if (!entries.length) return null;
  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Finale Extraktion" subheader="Konsolidierte Feldwerte (pro Prompt genau ein Wert)" />
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Feld</TableCell>
                <TableCell>Wert</TableCell>
                <TableCell width={180}>Confidence</TableCell>
                <TableCell>Seite</TableCell>
                <TableCell>Zitat</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([key, v]) => (
                  <TableRow key={key}>
                    <TableCell><Chip size="small" label={key} /></TableCell>
                    <TableCell>{formatValue((v as any).value)}</TableCell>
                    <TableCell><ConfidenceBar value={(v as any).confidence} /></TableCell>
                    <TableCell>{(v as any).page ?? "—"}</TableCell>
                    <TableCell>{(v as any).quote ?? "—"}</TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

function FinalScoringCard({ scores }: { scores?: Record<string, any> }) {
  const entries = useMemo(() => Object.entries(scores ?? {}), [scores]);
  if (!entries.length) return null;
  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Scoring (final)" subheader="Ja/Nein-Bewertung aus Batch-Signalen" />
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Score-Key</TableCell>
                <TableCell>Ergebnis</TableCell>
                <TableCell width={180}>Confidence</TableCell>
                <TableCell>Votes T/F</TableCell>
                <TableCell>Erklärung</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([key, v]) => (
                  <TableRow key={key}>
                    <TableCell><Chip size="small" label={key} /></TableCell>
                    <TableCell><Chip size="small" color={v.result ? "success" : "error"} label={v.result ? "Ja" : "Nein"} /></TableCell>
                    <TableCell><ConfidenceBar value={v.confidence} /></TableCell>
                    <TableCell>{(v.votes_true ?? 0)}/{(v.votes_false ?? 0)}</TableCell>
                    <TableCell>{v.explanation ?? "—"}</TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

function FinalDecisionCard({ decisions }: { decisions?: Record<string, any> }) {
  const entries = useMemo(() => Object.entries(decisions ?? {}), [decisions]);
  if (!entries.length) return null;
  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Decision (final)" subheader="Finale Routen-/Ja/Nein-Entscheidungen" />
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Decision-Key</TableCell>
                <TableCell>Route</TableCell>
                <TableCell>Answer</TableCell>
                <TableCell width={180}>Confidence</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([key, v]) => (
                  <TableRow key={key}>
                    <TableCell><Chip size="small" label={key} /></TableCell>
                    <TableCell><Chip size="small" label={v.route} /></TableCell>
                    <TableCell>
                      {typeof v.answer === "boolean"
                          ? <Chip size="small" color={v.answer ? "success" : "error"} label={v.answer ? "Ja" : "Nein"} />
                          : "—"}
                    </TableCell>
                    <TableCell><ConfidenceBar value={v.confidence} /></TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

function HintsCard({ data }: { data: PipelineRunResult }) {
  const lowExtraction = Object.values((data.extracted ?? {}) as any).some((x: any) => x?.confidence < CONF_WARN);
  const lowScoring   = Object.values(((data as any).scores ?? {}) as any).some((x: any) => x?.confidence < CONF_WARN);
  const lowDecision  = Object.values(((data as any).decisions ?? {}) as any).some((x: any) => x?.confidence < CONF_WARN);
  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Hinweise" />
        <CardContent>
          <Stack spacing={1}>
            <Typography variant="body2"><b>Overall:</b> {typeof data.overall_score === "number" ? data.overall_score.toFixed(2) : "—"}</Typography>
            <Typography variant="body2">
              {lowExtraction || lowScoring || lowDecision
                  ? "⚠️ Einige finale Ergebnisse liegen unter der Konfidenzschwelle."
                  : "Alle finalen Ergebnisse liegen über der Konfidenzschwelle."}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Tipp: Unten ein Prompt-Panel aufklappen, um die Evidenzen einzusehen.
            </Typography>
          </Stack>
        </CardContent>
      </Card>
  );
}

/* ---------- Drilldown (Batch-Evidenz) ---------- */

function PromptDrilldown({ data }: { data: PipelineRunResult }) {
  const extractByPid = useMemo(() => groupByPid((data.extraction ?? []) as any[]), [data.extraction]);
  const scoringByPid = useMemo(() => groupByPid((data.scoring ?? []) as any[]), [data.scoring]);
  const decisionByPid = useMemo(() => groupByPid((data.decision ?? []) as any[]), [data.decision]);

  return (
      <Card variant="outlined">
        <CardHeader title="Evidenz pro Prompt" subheader="Batch-Ergebnisse nach Prompt gruppiert" />
        <CardContent>
          {/* Extraction */}
          {Object.entries(extractByPid).map(([pid, items]) => (
              <Accordion key={`ex-${pid}`} defaultExpanded>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography sx={{ flex: 1 }}>
                    Extraction #{pid} – {(items as any)[0]?.prompt_text ?? "Prompt"}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Seite</TableCell>
                        <TableCell>Zitat</TableCell>
                        <TableCell>Wert</TableCell>
                        <TableCell>Fehler</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(items as PromptResult[]).map((r, i) => (
                          <TableRow key={i} hover>
                            <TableCell>{r.source?.page ?? "—"}</TableCell>
                            <TableCell>{r.source?.quote ?? "—"}</TableCell>
                            <TableCell>{formatValue(r.value)}</TableCell>
                            <TableCell>{r.error ?? ""}</TableCell>
                          </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
          ))}

          {/* Scoring */}
          {Object.entries(scoringByPid).map(([pid, items]) => (
              <Accordion key={`sc-${pid}`}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography sx={{ flex: 1 }}>Scoring #{pid}</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Seite</TableCell>
                        <TableCell>Ergebnis</TableCell>
                        <TableCell>Erklärung</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(items as ScoringResult[]).map((s, i) => (
                          <TableRow key={i} hover>
                            <TableCell>{s.source?.page ?? "—"}</TableCell>
                            <TableCell>{s.result ? "Ja" : "Nein"}</TableCell>
                            <TableCell>{s.explanation || "—"}</TableCell>
                          </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
          ))}

          {/* Decision */}
          {Object.entries(decisionByPid).map(([pid, items]) => (
              <Accordion key={`dc-${pid}`}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography sx={{ flex: 1 }}>Decision #{pid}</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Seite</TableCell>
                        <TableCell>Route</TableCell>
                        <TableCell>Answer</TableCell>
                        <TableCell>Erklärung</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(items as PromptResult[]).map((r, i) => (
                          <TableRow key={i} hover>
                            <TableCell>{r.source?.page ?? "—"}</TableCell>
                            <TableCell>{r.route ?? "—"}</TableCell>
                            <TableCell>{typeof r.boolean === "boolean" ? (r.boolean ? "Ja" : "Nein") : "—"}</TableCell>
                            <TableCell>{(r.value && typeof r.value === "object" && (r.value as any).explanation) || "—"}</TableCell>
                          </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
          ))}
        </CardContent>
      </Card>
  );
}

/* ---------- helpers ---------- */

function ConfidenceBar({ value }: { value?: number }) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  return (
      <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 160 }}>
        <Box sx={{ flex: 1 }}>
          <LinearProgress variant="determinate" value={v * 100} />
        </Box>
        <Typography variant="caption" sx={{ width: 36, textAlign: "right" }}>
          {(v * 100).toFixed(0)}%
        </Typography>
      </Stack>
  );
}

function groupByPid<T extends { prompt_id: number }>(arr: T[]): Record<number, T[]> {
  return arr.reduce<Record<number, T[]>>((acc, cur) => {
    (acc[cur.prompt_id] ||= []).push(cur);
    return acc;
  }, {});
}

function formatValue(val: any) {
  if (val == null) return "—";
  if (typeof val === "number") return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(val);
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}
