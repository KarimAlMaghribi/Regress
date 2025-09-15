import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Box, Card, CardContent, CardHeader, Chip, CircularProgress, Container,
  Grid, IconButton, LinearProgress, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, Tooltip, Typography, Accordion, AccordionSummary,
  AccordionDetails, Alert, TextField, FormControlLabel, Switch, Divider
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
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
  weight?: number | null;
};

const CONF_WARN = 0.6;
const LS_PREFIX = "run-view:";

/** API-Basis (nur genutzt, wenn ?run_id=…) */
function getAPIBase(): string {
  const w = (window as any);
  return w.__ENV__?.PIPELINE_API_URL || import.meta.env?.VITE_PIPELINE_API_URL || "/pl";
}

/** Öffnet PDF bei der gewünschten Seite (Viewer-Fragment #page= wird von vielen PDF-Viewern unterstützt) */
function jumpToPDFPage(pdfUrl: string, page?: number, bbox?: number[] | null) {
  if (!pdfUrl || !page) return;
  // bbox wird hier nur in den Tooltip übernommen; echtes Highlighting erfordert einen eingebetteten Viewer
  const url = `${pdfUrl}#page=${page}`;
  window.open(url, "_blank", "noopener,noreferrer");
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
              Pipeline: {String((data as any).pipeline_id)} • PDF-ID: {data.pdfId} {typeof data.overallScore === "number" ? `• Final Score: ${data.overallScore?.toFixed(2)}` : ""}
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
          {/* Final Results (wichtigster Block, oben & links breit) */}
          <Grid item xs={12} md={8}>
            <FinalExtractionCard extracted={data.extracted} pdfUrl={pdfUrl} />
            <FinalScoringCard scores={(data as any).scores} pdfUrl={pdfUrl} />
            <FinalDecisionCard decisions={(data as any).decisions} pdfUrl={pdfUrl} />
          </Grid>

          {/* Hinweise / Meta */}
          <Grid item xs={12} md={4}>
            <SummaryCard data={data} />
            <HintsCard data={data} />
          </Grid>

          {/* Drilldown */}
          <Grid item xs={12}>
            <PromptDrilldown data={data} pdfUrl={pdfUrl} />
          </Grid>
        </Grid>
      </Container>
  );
}

/* ---------- Final Summary & Hints ---------- */

function SummaryCard({ data }: { data: PipelineRunResult }) {
  // Zählt unsichere Finals (keine Neuberechnung, reine Anzeige)
  const finalsExtraction = Object.values((data.extracted ?? {}) as any);
  const finalsScoring = Object.values(((data as any).scores ?? {}) as any);
  const finalsDecision = Object.values(((data as any).decisions ?? {}) as any);

  const warnExtract = finalsExtraction.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;
  const warnScore = finalsScoring.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;
  const warnDec = finalsDecision.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;

  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Finale Zusammenfassung" subheader="Priorisierte Übersicht der Normalisierung & Scores" />
        <CardContent>
          <Stack spacing={1}>
            <Row label="Final Score">
              {typeof data.overallScore === "number"
                  ? <ConfidenceBar value={clamp01(data.overallScore)} />
                  : <Typography variant="body2">—</Typography>}
            </Row>
            <Row label="Final Extracted">
              <Typography variant="body2">
                {finalsExtraction.length} Felder • {warnExtract > 0 ? `⚠️ ${warnExtract} unter ${CONF_WARN}` : "alle ≥ Schwelle"}
              </Typography>
            </Row>
            <Row label="Final Scoring">
              <Typography variant="body2">
                {finalsScoring.length} Regeln • {warnScore > 0 ? `⚠️ ${warnScore} unter ${CONF_WARN}` : "alle ≥ Schwelle"}
              </Typography>
            </Row>
            <Row label="Final Decision">
              <Typography variant="body2">
                {finalsDecision.length} Entscheidungen • {warnDec > 0 ? `⚠️ ${warnDec} unter ${CONF_WARN}` : "alle ≥ Schwelle"}
              </Typography>
            </Row>
          </Stack>
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
            <Typography variant="body2">
              {(lowExtraction || lowScoring || lowDecision)
                  ? "⚠️ Einige finale Ergebnisse liegen unter der Konfidenzschwelle."
                  : "Alle finalen Ergebnisse liegen über der Konfidenzschwelle."}
            </Typography>
            <Stack direction="row" alignItems="center" gap={1}>
              <InfoOutlinedIcon fontSize="small" color="action" />
              <Typography variant="caption" color="text.secondary">
                Tipp: In den Tabellen auf „Seite X“ klicken, um zur Evidenz im PDF zu springen.
              </Typography>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
  );
}

/* ---------- Final Cards (priorisiert) ---------- */

function FinalExtractionCard(
    { extracted, pdfUrl }: { extracted?: PipelineRunResult["extracted"], pdfUrl: string }
) {
  const entries = useMemo(() => Object.entries(extracted ?? {}), [extracted]);
  if (!entries.length) return null;
  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader
            title="Finale Extraktion"
            subheader="Konsolidierte Normalisierungs-Ergebnisse pro Feld"
        />
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
              {entries.map(([key, v]) => {
                const vv: any = v || {};
                const page = vv.page as number | undefined;
                const quote = vv.quote as string | undefined;
                const bbox = (vv.source?.bbox ?? vv.bbox) as number[] | undefined; // falls backend bbox direkt anlegt
                return (
                    <TableRow key={key}>
                      <TableCell><Chip size="small" label={key} /></TableCell>
                      <TableCell>{formatValue(vv.value)}</TableCell>
                      <TableCell><ConfidenceBar value={vv.confidence} /></TableCell>
                      <TableCell>
                        {page ? (
                            <EvidenceChip page={page} pdfUrl={pdfUrl} bbox={bbox} />
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        {quote
                            ? <Tooltip title={quote}><Typography noWrap sx={{ maxWidth: 360 }}>{quote}</Typography></Tooltip>
                            : "—"}
                      </TableCell>
                    </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

function FinalScoringCard(
    { scores, pdfUrl }: { scores?: Record<string, any>, pdfUrl: string }
) {
  const entries = useMemo(() => Object.entries(scores ?? {}), [scores]);
  if (!entries.length) return null;

  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Scoring (final)" subheader="Ja/Nein-Ergebnis (aggregiert) mit Evidenz" />
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Score-Key</TableCell>
                <TableCell>Ergebnis</TableCell>
                <TableCell width={180}>Confidence</TableCell>
                <TableCell>Votes T/F</TableCell>
                <TableCell>Erklärung</TableCell>
                <TableCell>Support (Top 3)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([key, v]) => {
                const vv: any = v || {};
                const support: TextPosition[] = Array.isArray(vv.support) ? vv.support.slice(0, 3) : [];
                return (
                    <TableRow key={key}>
                      <TableCell><Chip size="small" label={key} /></TableCell>
                      <TableCell>
                        <Chip size="small" color={vv.result ? "success" : "error"} label={vv.result ? "Ja" : "Nein"} />
                      </TableCell>
                      <TableCell><ConfidenceBar value={vv.confidence} /></TableCell>
                      <TableCell>{(vv.votes_true ?? 0)} / {(vv.votes_false ?? 0)}</TableCell>
                      <TableCell>{vv.explanation ?? "—"}</TableCell>
                      <TableCell>
                        <Stack direction="row" gap={0.5} flexWrap="wrap">
                          {support.length
                              ? support.map((s, i) => (
                                  <EvidenceChip key={i} page={s.page} pdfUrl={pdfUrl} bbox={s.bbox} quote={s.quote ?? undefined} />
                              ))
                              : "—"}
                        </Stack>
                      </TableCell>
                    </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

function FinalDecisionCard(
    { decisions, pdfUrl }: { decisions?: Record<string, any>, pdfUrl: string }
) {
  const entries = useMemo(() => Object.entries(decisions ?? {}), [decisions]);
  if (!entries.length) return null;

  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Decision (final)" subheader="Routen-/Ja/Nein-Entscheidung (aggregiert) mit Evidenz" />
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Decision-Key</TableCell>
                <TableCell>Route</TableCell>
                <TableCell>Answer</TableCell>
                <TableCell width={180}>Confidence</TableCell>
                <TableCell>Votes Y/N</TableCell>
                <TableCell>Erklärung</TableCell>
                <TableCell>Support (Top 3)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([key, v]) => {
                const vv: any = v || {};
                const support: TextPosition[] = Array.isArray(vv.support) ? vv.support.slice(0, 3) : [];
                return (
                    <TableRow key={key}>
                      <TableCell><Chip size="small" label={key} /></TableCell>
                      <TableCell><Chip size="small" label={vv.route} /></TableCell>
                      <TableCell>
                        {typeof vv.answer === "boolean"
                            ? <Chip size="small" color={vv.answer ? "success" : "error"} label={vv.answer ? "Ja" : "Nein"} />
                            : "—"}
                      </TableCell>
                      <TableCell><ConfidenceBar value={vv.confidence} /></TableCell>
                      <TableCell>
                        {typeof vv.votes_yes === "number" || typeof vv.votes_no === "number"
                            ? `${vv.votes_yes ?? 0} / ${vv.votes_no ?? 0}` : "—"}
                      </TableCell>
                      <TableCell>{vv.explanation ?? "—"}</TableCell>
                      <TableCell>
                        <Stack direction="row" gap={0.5} flexWrap="wrap">
                          {support.length
                              ? support.map((s, i) => (
                                  <EvidenceChip key={i} page={s.page} pdfUrl={pdfUrl} bbox={s.bbox} quote={s.quote ?? undefined} />
                              ))
                              : "—"}
                        </Stack>
                      </TableCell>
                    </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

/* ---------- Drilldown (Batch-Evidenz) ---------- */

function PromptDrilldown({ data, pdfUrl }: { data: PipelineRunResult, pdfUrl: string }) {
  const extractByPid = useMemo(() => groupByPid((data.extraction ?? []) as any[]), [data.extraction]);
  const scoringByPid = useMemo(() => groupByPid((data.scoring ?? []) as any[]), [data.scoring]);
  const decisionByPid = useMemo(() => groupByPid((data.decision ?? []) as any[]), [data.decision]);

  // Simple inline Filter ohne zusätzliche Komponenten (nur Anzeige/Reduktion, keine Neuberechnung)
  const [q, setQ] = useState("");
  const [onlyErr, setOnlyErr] = useState(false);

  const qlc = q.trim().toLowerCase();
  const match = (txt?: string | null) => (txt ?? "").toLowerCase().includes(qlc);

  const filterPR = <T extends PromptResult | ScoringResult>(arr: T[]) => {
    return arr.filter((r: any) => {
      if (onlyErr && !r?.error) return false;
      if (!qlc) return true;
      // Textsuche über prompt_text, value, route, explanation, quote
      const parts: string[] = [];
      if (r.prompt_text) parts.push(r.prompt_text);
      if (typeof (r as any).value !== "object") parts.push(String((r as any).value ?? ""));
      if ((r as any).route) parts.push(String((r as any).route));
      if ((r as any).explanation) parts.push(String((r as any).explanation));
      if (r.source?.quote) parts.push(String(r.source.quote));
      return parts.some(p => match(p));
    });
  };

  return (
      <Card variant="outlined">
        <CardHeader
            title="Evidenz pro Prompt"
            subheader="Batch-Ergebnisse nach Prompt gruppiert (inkl. Batch-Confidence, Seite, Zitat, BBox)"
        />
        <CardContent>
          <Stack direction={{ xs: "column", sm: "row" }} gap={1} sx={{ mb: 2 }}>
            <TextField
                size="small"
                label="Suche in Evidenzen"
                value={q}
                onChange={e => setQ(e.target.value)}
                sx={{ width: { xs: "100%", sm: 360 } }}
            />
            <FormControlLabel
                control={<Switch checked={onlyErr} onChange={e => setOnlyErr(e.target.checked)} />}
                label="Nur Fehler"
            />
          </Stack>

          {/* Extraction */}
          {Object.entries(extractByPid).map(([pid, items]) => {
            const list = filterPR(items as PromptResult[]);
            if (!list.length) return null;
            return (
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
                          <TableCell width={180}>Batch-Confidence</TableCell>
                          <TableCell>JSON-Key</TableCell>
                          <TableCell>BBox</TableCell>
                          <TableCell>Fehler</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {list.map((r, i) => (
                            <TableRow key={i} hover>
                              <TableCell>
                                {r.source?.page
                                    ? <EvidenceChip page={r.source.page} pdfUrl={pdfUrl} bbox={r.source?.bbox} quote={r.source?.quote ?? undefined} />
                                    : "—"}
                              </TableCell>
                              <TableCell>
                                {r.source?.quote
                                    ? <Tooltip title={r.source.quote}><Typography noWrap sx={{ maxWidth: 360 }}>{r.source.quote}</Typography></Tooltip>
                                    : "—"}
                              </TableCell>
                              <TableCell>{formatValue(r.value)}</TableCell>
                              <TableCell><ConfidenceBar value={r.weight ?? undefined} /></TableCell>
                              <TableCell>{r.json_key ?? "—"}</TableCell>
                              <TableCell>
                                {Array.isArray(r.source?.bbox)
                                    ? <Tooltip title={String(r.source?.bbox)}>
                                      <Chip size="small" label="BBox" variant="outlined" />
                                    </Tooltip>
                                    : "—"}
                              </TableCell>
                              <TableCell>{r.error ?? ""}</TableCell>
                            </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionDetails>
                </Accordion>
            );
          })}

          {/* Scoring */}
          {Object.entries(scoringByPid).map(([pid, items]) => {
            const list = filterPR(items as any as ScoringResult[]);
            if (!list.length) return null;
            return (
                <Accordion key={`sc-${pid}`}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography sx={{ flex: 1 }}>
                      Scoring #{pid} – {(items as any)[0]?.prompt_text ?? "Prompt"}
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Seite</TableCell>
                          <TableCell>Ergebnis</TableCell>
                          <TableCell>Erklärung</TableCell>
                          <TableCell width={180}>Batch-Confidence</TableCell>
                          <TableCell>BBox</TableCell>
                          <TableCell>Fehler</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {list.map((s: any, i: number) => (
                            <TableRow key={i} hover>
                              <TableCell>
                                {s.source?.page
                                    ? <EvidenceChip page={s.source.page} pdfUrl={pdfUrl} bbox={s.source?.bbox} quote={s.source?.quote ?? undefined} />
                                    : "—"}
                              </TableCell>
                              <TableCell>{s.result ? "Ja" : "Nein"}</TableCell>
                              <TableCell>{s.explanation || "—"}</TableCell>
                              <TableCell><ConfidenceBar value={s.weight ?? undefined} /></TableCell>
                              <TableCell>
                                {Array.isArray(s.source?.bbox)
                                    ? <Tooltip title={String(s.source?.bbox)}>
                                      <Chip size="small" label="BBox" variant="outlined" />
                                    </Tooltip>
                                    : "—"}
                              </TableCell>
                              <TableCell>{(s as any).error ?? ""}</TableCell>
                            </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionDetails>
                </Accordion>
            );
          })}

          {/* Decision */}
          {Object.entries(decisionByPid).map(([pid, items]) => {
            const list = filterPR(items as PromptResult[]);
            if (!list.length) return null;
            return (
                <Accordion key={`dc-${pid}`}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography sx={{ flex: 1 }}>
                      Decision #{pid} – {(items as any)[0]?.prompt_text ?? "Prompt"}
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Seite</TableCell>
                          <TableCell>Route</TableCell>
                          <TableCell>Answer</TableCell>
                          <TableCell>Erklärung</TableCell>
                          <TableCell width={180}>Batch-Confidence</TableCell>
                          <TableCell>BBox</TableCell>
                          <TableCell>Fehler</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {list.map((r, i) => (
                            <TableRow key={i} hover>
                              <TableCell>
                                {r.source?.page
                                    ? <EvidenceChip page={r.source.page} pdfUrl={pdfUrl} bbox={r.source?.bbox} quote={r.source?.quote ?? undefined} />
                                    : "—"}
                              </TableCell>
                              <TableCell>{r.route ?? "—"}</TableCell>
                              <TableCell>{typeof r.boolean === "boolean" ? (r.boolean ? "Ja" : "Nein") : "—"}</TableCell>
                              <TableCell>{(r.value && typeof r.value === "object" && (r.value as any).explanation) || "—"}</TableCell>
                              <TableCell><ConfidenceBar value={r.weight ?? undefined} /></TableCell>
                              <TableCell>
                                {Array.isArray(r.source?.bbox)
                                    ? <Tooltip title={String(r.source?.bbox)}>
                                      <Chip size="small" label="BBox" variant="outlined" />
                                    </Tooltip>
                                    : "—"}
                              </TableCell>
                              <TableCell>{r.error ?? ""}</TableCell>
                            </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionDetails>
                </Accordion>
            );
          })}
        </CardContent>
      </Card>
  );
}

/* ---------- helpers ---------- */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" sx={{ minWidth: 130, color: "text.secondary" }}>{label}</Typography>
        <Box sx={{ flex: 1 }}>{children}</Box>
      </Stack>
  );
}

function EvidenceChip({ page, pdfUrl, bbox, quote }: { page: number; pdfUrl: string; bbox?: number[] | null; quote?: string }) {
  return (
      <Tooltip title={quote ? `Seite ${page}${bbox ? ` • BBox: ${bbox.join(",")}` : ""}\n${quote}` : `Seite ${page}${bbox ? ` • BBox: ${bbox.join(",")}` : ""}`}>
        <Chip
            size="small"
            label={`Seite ${page}`}
            onClick={() => jumpToPDFPage(pdfUrl, page, bbox ?? undefined)}
            variant="outlined"
        />
      </Tooltip>
  );
}

function ConfidenceBar({ value }: { value?: number | null }) {
  const v = clamp01(value ?? 0);
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

function clamp01(n: number) {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
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
