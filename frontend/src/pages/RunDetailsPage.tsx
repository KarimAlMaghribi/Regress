import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Box, Card, CardContent, CardHeader, Chip, CircularProgress, Container,
  Grid, IconButton, LinearProgress, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, Tooltip, Typography, Accordion, AccordionSummary,
  AccordionDetails, Alert, TextField, FormControlLabel, Switch
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
// Falls es den Typ bei dir gibt – ansonsten einfach auf 'any' lassen:
import type { PipelineRunResult } from "../types/pipeline";

type TextPosition = { page?: number; bbox?: number[]; quote?: string | null };
type PromptType = "ExtractionPrompt" | "ScoringPrompt" | "DecisionPrompt";

type PromptResult = {
  prompt_id: number;
  prompt_type: PromptType;
  prompt_text: string;
  value?: any | null;
  boolean?: boolean | null;
  route?: string | null;
  weight?: number | null;       // Batch-Confidence/Gewichtung (vom Backend)
  source?: TextPosition | null; // Evidence-Position
  openai_raw?: string;
  json_key?: string | null;
  error?: string | null;
};

type ScoringResult = {
  prompt_id: number;
  prompt_text?: string;
  result: boolean;
  source?: TextPosition;
  explanation?: string;
  weight?: number | null;
  error?: string | null;
};

const CONF_WARN = 0.6;
const LS_PREFIX = "run-view:";

/* ===================== Utilities / Diagnose ===================== */

function getAPIBase(): string {
  const w = (window as any);
  return w.__ENV__?.PIPELINE_API_URL || (import.meta as any)?.env?.VITE_PIPELINE_API_URL || "/pl";
}

function dlog(label: string, payload?: any) {
  // zentrale Log-Funktion – leicht filterbar
  // eslint-disable-next-line no-console
  console.log(`[RunView] ${label}`, payload ?? "");
}

function summarizeArray(arr: any[] | undefined | null, pick?: (x: any) => any) {
  if (!Array.isArray(arr)) return { len: 0 };
  const len = arr.length;
  const head = arr.slice(0, 3).map(x => (pick ? pick(x) : x));
  return { len, head };
}

function countWeightPresence(arr: any[] | undefined | null) {
  if (!Array.isArray(arr)) return { present: 0, absent: 0 };
  let present = 0, absent = 0;
  for (const r of arr) {
    if (r && typeof r.weight === "number") present++;
    else absent++;
  }
  return { present, absent };
}

function keysOf(obj: any) {
  return obj && typeof obj === "object" ? Object.keys(obj) : [];
}

function clamp01(n: number) {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function groupByPid<T extends { prompt_id: number }>(arr: T[] = []): Record<number, T[]> {
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

/* ===================== Component ===================== */

export default function RunDetailsPage() {
  const { key } = useParams<{ key: string }>();
  const [sp] = useSearchParams();
  const runId = sp.get("run_id") || undefined;

  const [data, setData] = useState<PipelineRunResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  // ---- Loaders ----
  const loadFromLocalStorage = React.useCallback(() => {
    if (!key) return false;
    const raw = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      // Erwartete Struktur: { run: PipelineRunResult, pdfUrl?: string }
      if (parsed?.run) {
        setData(parsed.run as PipelineRunResult);
        dlog("Loaded from localStorage", {
          lsKey: `${LS_PREFIX}${key}`,
          topKeys: keysOf(parsed.run),
          pdfUrl: parsed?.pdfUrl ?? null,
        });
        // Sofortige Diagnose der Struktur
        printRunDiagnostics(parsed.run as PipelineRunResult, "localStorage");
        return true;
      } else {
        dlog("LocalStorage entry does not have 'run' prop", parsed);
      }
    } catch (e) {
      dlog("LocalStorage parse error", String(e));
    }
    return false;
  }, [key]);

  const fetchRunById = React.useCallback(async () => {
    if (!runId) return false;
    setErr(null);
    try {
      const API = getAPIBase();
      dlog("Fetching run by id", { API, runId });
      const res = await fetch(`${API}/runs/${runId}`, { headers: { Accept: "application/json" } });
      const ct = res.headers.get("content-type") || "";
      const textCopy = await res.clone().text(); // copy for debugging if parse fails
      if (!ct.includes("application/json")) {
        throw new Error(`Expected JSON, got ${ct}\nBody: ${textCopy.slice(0, 300)}…`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${textCopy.slice(0, 300)}…`);
      const json = (await res.json()) as PipelineRunResult;
      setData(json);
      dlog("Fetched by API", { topKeys: keysOf(json) });
      printRunDiagnostics(json, "api");
      return true;
    } catch (e: any) {
      setErr(e?.message ?? "Fehler beim Laden");
      dlog("Fetch error", e);
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

  const pdfUrl = React.useMemo(() => {
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

  // ---------- Render ----------
  return (
      <Container maxWidth="xl" sx={{ py: 3 }}>
        {/* Header */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h5">Run-Details</Typography>
            <Typography variant="body2" color="text.secondary">
              Pipeline: {String((data as any).pipeline_id)} • PDF-ID: {data.pdf_id} {typeof data.overall_score === "number" ? `• Final Score: ${data.overall_score?.toFixed(2)}` : ""}
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

/* ===================== Summary + Hints ===================== */

function SummaryCard({ data }: { data: PipelineRunResult }) {
  const finalsExtraction = Object.values((data.extracted ?? {}) as any);
  const finalsScoring = Object.values(((data as any).scores ?? {}) as any);
  const finalsDecision = Object.values(((data as any).decisions ?? {}) as any);

  const warnExtract = finalsExtraction.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;
  const warnScore = finalsScoring.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;
  const warnDec = finalsDecision.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;

  // Diagnose: Warum alles 0/—?
  React.useEffect(() => {
    dlog("SummaryCard finals", {
      extracted_keys: Object.keys(data.extracted ?? {}),
      scores_keys: Object.keys((data as any).scores ?? {}),
      decisions_keys: Object.keys((data as any).decisions ?? {}),
      overall_score: data.overall_score,
      warnExtract,
      warnScore,
      warnDec,
    });
  }, [data, warnExtract, warnScore, warnDec]);

  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Finale Zusammenfassung" subheader="Priorisierte Übersicht der Normalisierung & Scores" />
        <CardContent>
          <Stack spacing={1}>
            <Row label="Final Score">
              {typeof data.overall_score === "number"
                  ? <ConfidenceBar value={clamp01(data.overall_score)} />
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

  React.useEffect(() => {
    dlog("HintsCard thresholds", { CONF_WARN, lowExtraction, lowScoring, lowDecision });
  }, [lowExtraction, lowScoring, lowDecision]);

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

/* ===================== Final Cards ===================== */

function FinalExtractionCard({ extracted, pdfUrl }: { extracted?: PipelineRunResult["extracted"], pdfUrl: string }) {
  const entries = useMemo(() => Object.entries(extracted ?? {}), [extracted]);

  useEffect(() => {
    dlog("FinalExtractionCard", {
      count: entries.length,
      sample: entries.slice(0, 3).map(([k, v]) => ({ k, v })),
    });
  }, [entries]);

  if (!entries.length) return null;
  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Finale Extraktion" subheader="Konsolidierte Normalisierungs-Ergebnisse pro Feld" />
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
              {entries.map(([key, v]: any) => {
                const page = v?.page as number | undefined;
                const quote = v?.quote as string | undefined;
                const bbox = (v?.source?.bbox ?? v?.bbox) as number[] | undefined;
                return (
                    <TableRow key={key}>
                      <TableCell><Chip size="small" label={key} /></TableCell>
                      <TableCell>{formatValue(v?.value)}</TableCell>
                      <TableCell><ConfidenceBar value={v?.confidence} /></TableCell>
                      <TableCell>
                        {page ? <EvidenceChip page={page} pdfUrl={pdfUrl} bbox={bbox} quote={quote} /> : "—"}
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

function FinalScoringCard({ scores, pdfUrl }: { scores?: Record<string, any>, pdfUrl: string }) {
  const entries = useMemo(() => Object.entries(scores ?? {}), [scores]);

  useEffect(() => {
    dlog("FinalScoringCard", {
      count: entries.length,
      sample: entries.slice(0, 3).map(([k, v]) => ({ k, v })),
    });
  }, [entries]);

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
              {entries.map(([key, v]: any) => {
                const support: TextPosition[] = Array.isArray(v?.support) ? v.support.slice(0, 3) : [];
                return (
                    <TableRow key={key}>
                      <TableCell><Chip size="small" label={key} /></TableCell>
                      <TableCell>
                        <Chip size="small" color={v?.result ? "success" : "error"} label={v?.result ? "Ja" : "Nein"} />
                      </TableCell>
                      <TableCell><ConfidenceBar value={v?.confidence} /></TableCell>
                      <TableCell>{(v?.votes_true ?? 0)} / {(v?.votes_false ?? 0)}</TableCell>
                      <TableCell>{v?.explanation ?? "—"}</TableCell>
                      <TableCell>
                        <Stack direction="row" gap={0.5} flexWrap="wrap">
                          {support.length
                              ? support.map((s, i) => (
                                  <EvidenceChip key={i} page={s.page!} pdfUrl={pdfUrl} bbox={s.bbox} quote={s.quote ?? undefined} />
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

function FinalDecisionCard({ decisions, pdfUrl }: { decisions?: Record<string, any>, pdfUrl: string }) {
  const entries = useMemo(() => Object.entries(decisions ?? {}), [decisions]);

  useEffect(() => {
    dlog("FinalDecisionCard", {
      count: entries.length,
      sample: entries.slice(0, 3).map(([k, v]) => ({ k, v })),
    });
  }, [entries]);

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
              {entries.map(([key, v]: any) => {
                const support: TextPosition[] = Array.isArray(v?.support) ? v.support.slice(0, 3) : [];
                return (
                    <TableRow key={key}>
                      <TableCell><Chip size="small" label={key} /></TableCell>
                      <TableCell><Chip size="small" label={v?.route} /></TableCell>
                      <TableCell>
                        {typeof v?.answer === "boolean"
                            ? <Chip size="small" color={v?.answer ? "success" : "error"} label={v?.answer ? "Ja" : "Nein"} />
                            : "—"}
                      </TableCell>
                      <TableCell><ConfidenceBar value={v?.confidence} /></TableCell>
                      <TableCell>
                        {typeof v?.votes_yes === "number" || typeof v?.votes_no === "number"
                            ? `${v?.votes_yes ?? 0} / ${v?.votes_no ?? 0}` : "—"}
                      </TableCell>
                      <TableCell>{v?.explanation ?? "—"}</TableCell>
                      <TableCell>
                        <Stack direction="row" gap={0.5} flexWrap="wrap">
                          {support.length
                              ? support.map((s, i) => (
                                  <EvidenceChip key={i} page={s.page!} pdfUrl={pdfUrl} bbox={s.bbox} quote={s.quote ?? undefined} />
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

/* ===================== Drilldown ===================== */

function PromptDrilldown({ data, pdfUrl }: { data: PipelineRunResult, pdfUrl: string }) {
  const extractByPid = useMemo(() => groupByPid((data.extraction as any[]) ?? []), [data.extraction]);
  const scoringByPid = useMemo(() => groupByPid((data.scoring as any[]) ?? []), [data.scoring]);
  const decisionByPid = useMemo(() => groupByPid((data.decision as any[]) ?? []), [data.decision]);

  // Erste Diagnose direkt beim Gruppieren
  useEffect(() => {
    dlog("Drilldown: groups", {
      extraction_pids: Object.keys(extractByPid),
      scoring_pids: Object.keys(scoringByPid),
      decision_pids: Object.keys(decisionByPid),
    });
    const ex = ([] as any[]).concat(...Object.values(extractByPid));
    const sc = ([] as any[]).concat(...Object.values(scoringByPid));
    const dc = ([] as any[]).concat(...Object.values(decisionByPid));
    dlog("Drilldown: weight presence", {
      extraction: countWeightPresence(ex),
      scoring: countWeightPresence(sc),
      decision: countWeightPresence(dc),
    });
    dlog("Drilldown: sample extraction", summarizeArray(ex, r => ({
      pid: r.prompt_id, value: r.value, weight: r.weight, error: r.error,
      page: r?.source?.page, route: r?.route
    })));
    dlog("Drilldown: sample scoring", summarizeArray(sc, r => ({
      pid: r.prompt_id, result: r.result, weight: r.weight, explanation: r.explanation,
      page: r?.source?.page
    })));
    dlog("Drilldown: sample decision", summarizeArray(dc, r => ({
      pid: r.prompt_id, route: r.route, bool: r.boolean, weight: r.weight,
      page: r?.source?.page, err: r.error
    })));
  }, [extractByPid, scoringByPid, decisionByPid]);

  const [q, setQ] = useState("");
  const [onlyErr, setOnlyErr] = useState(false);
  const qlc = q.trim().toLowerCase();
  const match = (txt?: string | null) => (txt ?? "").toLowerCase().includes(qlc);

  const filterPR = <T extends PromptResult | ScoringResult>(arr: T[]) => {
    return arr.filter((r: any) => {
      if (onlyErr && !r?.error) return false;
      if (!qlc) return true;
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
            <TextField size="small" label="Suche in Evidenzen" value={q} onChange={e => setQ(e.target.value)} sx={{ width: { xs: "100%", sm: 360 } }} />
            <FormControlLabel control={<Switch checked={onlyErr} onChange={e => setOnlyErr(e.target.checked)} />} label="Nur Fehler" />
          </Stack>

          {/* Extraction */}
          {Object.entries(extractByPid).map(([pid, items]) => {
            const list = filterPR(items as PromptResult[]);
            if (!list.length) return null;
            return (
                <Accordion key={`ex-${pid}`} defaultExpanded>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography sx={{ flex: 1 }}>Extraction #{pid} – {(items as any)[0]?.prompt_text ?? "Prompt"}</Typography>
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
                                    ? <EvidenceChip page={r.source.page!} pdfUrl={pdfUrl} bbox={r.source?.bbox ?? undefined} quote={r.source?.quote ?? undefined} />
                                    : "—"}
                              </TableCell>
                              <TableCell>
                                {r.source?.quote
                                    ? <Tooltip title={r.source.quote}><Typography noWrap sx={{ maxWidth: 360 }}>{r.source.quote}</Typography></Tooltip>
                                    : "—"}
                              </TableCell>
                              <TableCell>{formatValue(r.value)}</TableCell>
                              <TableCell>
                                <ConfidenceBar value={typeof r.weight === "number" ? r.weight : null} />
                                {typeof r.weight !== "number" && (
                                    <Typography variant="caption" color="text.secondary">— (keine weight im DTO)</Typography>
                                )}
                              </TableCell>
                              <TableCell>{r.json_key ?? "—"}</TableCell>
                              <TableCell>
                                {Array.isArray(r.source?.bbox)
                                    ? <Tooltip title={String(r.source?.bbox)}><Chip size="small" label="BBox" variant="outlined" /></Tooltip>
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
                    <Typography sx={{ flex: 1 }}>Scoring #{pid} – {(items as any)[0]?.prompt_text ?? "Prompt"}</Typography>
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
                                    ? <EvidenceChip page={s.source.page!} pdfUrl={pdfUrl} bbox={s.source?.bbox ?? undefined} quote={s.source?.quote ?? undefined} />
                                    : "—"}
                              </TableCell>
                              <TableCell>{s.result ? "Ja" : "Nein"}</TableCell>
                              <TableCell>{s.explanation || "—"}</TableCell>
                              <TableCell>
                                <ConfidenceBar value={typeof s.weight === "number" ? s.weight : null} />
                                {typeof s.weight !== "number" && (
                                    <Typography variant="caption" color="text.secondary">— (keine weight im DTO)</Typography>
                                )}
                              </TableCell>
                              <TableCell>
                                {Array.isArray(s.source?.bbox)
                                    ? <Tooltip title={String(s.source?.bbox)}><Chip size="small" label="BBox" variant="outlined" /></Tooltip>
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
                    <Typography sx={{ flex: 1 }}>Decision #{pid} – {(items as any)[0]?.prompt_text ?? "Prompt"}</Typography>
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
                                    ? <EvidenceChip page={r.source.page!} pdfUrl={pdfUrl} bbox={r.source?.bbox ?? undefined} quote={r.source?.quote ?? undefined} />
                                    : "—"}
                              </TableCell>
                              <TableCell>{r.route ?? "—"}</TableCell>
                              <TableCell>{typeof r.boolean === "boolean" ? (r.boolean ? "Ja" : "Nein") : "—"}</TableCell>
                              <TableCell>{(r.value && typeof r.value === "object" && (r.value as any).explanation) || "—"}</TableCell>
                              <TableCell>
                                <ConfidenceBar value={typeof r.weight === "number" ? r.weight : null} />
                                {typeof r.weight !== "number" && (
                                    <Typography variant="caption" color="text.secondary">— (keine weight im DTO)</Typography>
                                )}
                              </TableCell>
                              <TableCell>
                                {Array.isArray(r.source?.bbox)
                                    ? <Tooltip title={String(r.source?.bbox)}><Chip size="small" label="BBox" variant="outlined" /></Tooltip>
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

/* ===================== Small UI helpers ===================== */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" sx={{ minWidth: 130, color: "text.secondary" }}>{label}</Typography>
        <Box sx={{ flex: 1 }}>{children}</Box>
      </Stack>
  );
}

function EvidenceChip({ page, pdfUrl, bbox, quote }: { page: number; pdfUrl: string; bbox?: number[] | null; quote?: string }) {
  const title = `${`Seite ${page}`}${Array.isArray(bbox) ? ` • BBox: ${bbox.join(",")}` : ""}${quote ? `\n${quote}` : ""}`;
  return (
      <Tooltip title={title}>
        <Chip
            size="small"
            label={`Seite ${page}`}
            onClick={() => {
              if (!pdfUrl) dlog("PDF URL fehlt – kann nicht springen");
              const url = pdfUrl ? `${pdfUrl}#page=${page}` : undefined;
              dlog("Jump to PDF", { url, page, bbox, hasPdfUrl: !!pdfUrl });
              if (url) window.open(url, "_blank", "noopener,noreferrer");
            }}
            variant="outlined"
        />
      </Tooltip>
  );
}

function ConfidenceBar({ value }: { value?: number | null }) {
  if (value == null || Number.isNaN(value)) {
    return <Typography variant="body2">—</Typography>;
  }
  const v = clamp01(value);
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

/* ===================== Diagnostics ===================== */

function printRunDiagnostics(run: any, source: "localStorage" | "api") {
  // Top-Level
  dlog(`RUN (${source}) top-level`, {
    keys: keysOf(run),
    pdf_id: run?.pdf_id,
    pipeline_id: run?.pipeline_id,
    overall_score: run?.overall_score,
  });

  // Finals
  const exKeys = keysOf(run?.extracted ?? {});
  const scKeys = keysOf(run?.scores ?? {});
  const dcKeys = keysOf(run?.decisions ?? {});
  dlog("Finals present", { extracted_keys: exKeys, scores_keys: scKeys, decisions_keys: dcKeys });

  // Arrays
  const exArr = run?.extraction ?? [];
  const scArr = run?.scoring ?? [];
  const dcArr = run?.decision ?? [];

  dlog("Arrays summary", {
    extraction: summarizeArray(exArr, (r: any) => ({ pid: r?.prompt_id, hasValue: r?.value != null, weight: r?.weight, page: r?.source?.page, err: r?.error })),
    scoring: summarizeArray(scArr, (r: any) => ({ pid: r?.prompt_id, result: r?.result, weight: r?.weight, page: r?.source?.page, err: r?.error })),
    decision: summarizeArray(dcArr, (r: any) => ({ pid: r?.prompt_id, route: r?.route, bool: r?.boolean, weight: r?.weight, page: r?.source?.page, err: r?.error })),
  });

  // Batch-Weight-Verfügbarkeit
  dlog("Weight presence", {
    extraction: countWeightPresence(exArr),
    scoring: countWeightPresence(scArr),
    decision: countWeightPresence(dcArr),
  });

  // Hinweise, warum Finale leer sein könnten
  if (exKeys.length === 0 && scKeys.length === 0 && dcKeys.length === 0) {
    dlog("WARN: Keine finalen Maps vorhanden", {
      hint: "Lädst du evtl. ein nicht-konsolidiertes Objekt? Prüfe Konsolidierung/DTO-Ausspielung.",
      note: "Wenn extraction/scoring/decision nur Fehler enthalten oder keine validen Kandidaten haben, bleiben Finals leer.",
    });
  }
}
