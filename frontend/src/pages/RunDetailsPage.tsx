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
// Optional: bei dir ggf. "any" statt Import
import type { PipelineRunResult } from "../types/pipeline";

/* ===== Types ===== */
type TextPosition = { page?: number; bbox?: number[]; quote?: string | null };
type PromptType = "ExtractionPrompt" | "ScoringPrompt" | "DecisionPrompt";

type PromptResult = {
  prompt_id: number;
  prompt_type: PromptType;
  prompt_text: string;
  value?: any | null;
  boolean?: boolean | null;
  route?: string | null;
  weight?: number | null;       // Batch-Confidence (Backend)
  source?: TextPosition | null; // Evidence
  json_key?: string | null;
  explanation?: string | null;
  error?: string | null;
};

const CONF_WARN = 0.6;
const LS_PREFIX = "run-view:";

/* ===== Logging helpers ===== */
function dlog(label: string, payload?: any) {
  // eslint-disable-next-line no-console
  console.log(`[RunView] ${label}`, payload ?? "");
}
function keysOf(obj: any) { return obj && typeof obj === "object" ? Object.keys(obj) : []; }
function summarizeArray(arr: any[] | undefined | null, pick?: (x: any) => any) {
  if (!Array.isArray(arr)) return { len: 0, head: [] as any[] };
  const len = arr.length;
  const head = arr.slice(0, 3).map(x => (pick ? pick(x) : x));
  return { len, head };
}
function countWeightPresence(arr: any[] | undefined | null) {
  if (!Array.isArray(arr)) return { present: 0, absent: 0 };
  let present = 0, absent = 0;
  for (const r of arr) (typeof r?.weight === "number") ? present++ : absent++;
  return { present, absent };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }

/* ===== API base ===== */
function getAPIBase(): string {
  const w = (window as any);
  return w.__ENV__?.PIPELINE_API_URL || (import.meta as any)?.env?.VITE_PIPELINE_API_URL || "/pl";
}

/* ===== Final-map heuristics ===== */
function looksLikeExtractionMap(obj: any) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const vals = Object.values(obj);
  if (!vals.length) return false;
  const v = vals[0] as any;
  const hasConf = ("confidence" in (v ?? {})) || ("score" in (v ?? {})) || ("conf" in (v ?? {}));
  const hasFieldish = ("value" in (v ?? {})) || ("page" in (v ?? {})) || ("quote" in (v ?? {}));
  return hasConf && hasFieldish;
}
function looksLikeScoringMap(obj: any) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const vals = Object.values(obj);
  if (!vals.length) return false;
  const v = vals[0] as any;
  const hasConf = ("confidence" in (v ?? {})) || ("score" in (v ?? {})) || ("conf" in (v ?? {}));
  return (("result" in (v ?? {})) && hasConf) || ("votes_true" in (v ?? {}) || "votes_false" in (v ?? {}));
}
function looksLikeDecisionMap(obj: any) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const vals = Object.values(obj);
  if (!vals.length) return false;
  const v = vals[0] as any;
  const hasConf = ("confidence" in (v ?? {})) || ("score" in (v ?? {})) || ("conf" in (v ?? {}));
  return ("route" in (v ?? {})) && (hasConf || "answer" in (v ?? {}));
}

/* ===== Deep scan (rekursiv bis Tiefe 5) ===== */
type Found = { path: string; obj: any };
function deepFind(run: any, guard: (x:any)=>boolean, maxDepth = 5): Found | null {
  const seen = new WeakSet<object>();
  function rec(node: any, path: string[], depth: number): Found | null {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    if (seen.has(node)) return null;
    seen.add(node);
    try {
      if (guard(node)) return { path: path.join("."), obj: node };
    } catch { /* ignore */ }
    if (depth >= maxDepth) return null;
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") {
        const f = rec(v, [...path, k], depth + 1);
        if (f) return f;
      }
    }
    return null;
  }
  return rec(run, [], 0);
}

function detectFinalMaps(run: any) {
  const candidates = {
    extracted: [
      ["extracted", run?.extracted],
      ["final_extracted", run?.final_extracted],
      ["finalExtraction", run?.finalExtraction],
      ["normalized", run?.normalized],
      ["canonical", run?.canonical],
      ["canonical_fields", run?.canonical_fields],
    ],
    scores: [
      ["scores", run?.scores],
      ["final_scores", run?.final_scores],
      ["finalScoring", run?.finalScoring],
    ],
    decisions: [
      ["decisions", run?.decisions],
      ["final_decisions", run?.final_decisions],
      ["finalDecision", run?.finalDecision],
    ],
  } as const;

  function pickAlias(list: readonly [string, any][], guard: (x:any)=>boolean) {
    for (const [name, val] of list) {
      try { if (guard(val)) return { key: name, map: val, via: "alias" }; } catch {}
    }
    return null;
  }

  let ex = pickAlias(candidates.extracted, looksLikeExtractionMap);
  let sc = pickAlias(candidates.scores, looksLikeScoringMap);
  let dc = pickAlias(candidates.decisions, looksLikeDecisionMap);

  if (!ex) {
    const found = deepFind(run, looksLikeExtractionMap);
    if (found) ex = { key: found.path, map: found.obj, via: "deep" as const };
  }
  if (!sc) {
    const found = deepFind(run, looksLikeScoringMap);
    if (found) sc = { key: found.path, map: found.obj, via: "deep" as const };
  }
  if (!dc) {
    const found = deepFind(run, looksLikeDecisionMap);
    if (found) dc = { key: found.path, map: found.obj, via: "deep" as const };
  }

  dlog("Final maps detection", {
    extractedChosenKey: ex?.key, extractedCount: ex?.map ? Object.keys(ex.map).length : 0, extractedVia: ex?.via ?? null,
    scoresChosenKey: sc?.key, scoresCount: sc?.map ? Object.keys(sc.map).length : 0, scoresVia: sc?.via ?? null,
    decisionsChosenKey: dc?.key, decisionsCount: dc?.map ? Object.keys(dc.map).length : 0, decisionsVia: dc?.via ?? null,
  });

  return {
    extractedEff: ex?.map ?? {},
    scoresEff: sc?.map ?? {},
    decisionsEff: dc?.map ?? {},
    keys: { extracted: ex?.key, scores: sc?.key, decisions: dc?.key, via: { ex: ex?.via, sc: sc?.via, dc: dc?.via } }
  };
}

/* ===== Component ===== */
export default function RunDetailsPage() {
  const { key } = useParams<{ key: string }>();
  const [sp] = useSearchParams();
  const runId = sp.get("run_id") || undefined;

  const [data, setData] = useState<PipelineRunResult | any | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  // Loader (Hook-Order fix: alle Hooks vor Returns)
  const loadFromLocalStorage = React.useCallback(() => {
    if (!key) return false;
    const raw = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.run) {
        setData(parsed.run);
        (window as any).__run = parsed.run;
        dlog("Loaded from localStorage", {
          lsKey: `${LS_PREFIX}${key}`,
          runTopKeys: keysOf(parsed.run),
          pdfUrl: parsed?.pdfUrl ?? null,
        });
        printRunDiagnostics(parsed.run, "localStorage");
        return true;
      } else {
        dlog("LocalStorage entry missing 'run' property", parsed);
      }
    } catch (e) { dlog("LocalStorage parse error", String(e)); }
    return false;
  }, [key]);

  const fetchRunById = React.useCallback(async () => {
    if (!runId) return false;
    setErr(null);
    try {
      const API = getAPIBase();
      dlog("Fetching run by id", { API, runId });
      const res = await fetch(`${API}/runs/${runId}`, { headers: { Accept: "application/json" } });
      const bodyText = await res.clone().text();
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) throw new Error(`Expected JSON, got ${ct}\nBody: ${bodyText.slice(0,300)}…`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0,300)}…`);
      const json = JSON.parse(bodyText);
      setData(json);
      (window as any).__run = json;
      dlog("Fetched by API", { runTopKeys: keysOf(json) });
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
      if (runId) fetchRunById().finally(() => setLoading(false));
      else { setErr("Keine Daten gefunden (weder localStorage noch run_id)."); setLoading(false); }
    } else setLoading(false);
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

  // Final-Map-Detection (vor Returns; robust & deep)
  const { extractedEff, scoresEff, decisionsEff, keys: chosenKeys } = useMemo(
      () => detectFinalMaps(data),
      [data]
  );
  useEffect(() => { dlog("Chosen final map keys", chosenKeys); }, [chosenKeys]);

  /* ----- Returns ----- */
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
            Tipp: Seite aus der Liste erneut öffnen oder mit <code>?run_id=&lt;UUID&gt;</code>.
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
            <FinalExtractionCard extracted={extractedEff} pdfUrl={pdfUrl} />
            <FinalScoringCard scores={scoresEff} pdfUrl={pdfUrl} />
            <FinalDecisionCard decisions={decisionsEff} pdfUrl={pdfUrl} />
            {(Object.keys(extractedEff ?? {}).length === 0
                && Object.keys(scoresEff ?? {}).length === 0
                && Object.keys(decisionsEff ?? {}).length === 0) && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  Keine finalen Ergebnisse im DTO gefunden (auch nicht in verschachtelten Pfaden). Lädt der Client
                  evtl. ein Objekt <em>vor</em> der Konsolidierung? Siehe Konsole <code>[RunView]</code> Logs.
                </Alert>
            )}
          </Grid>

          {/* Hinweise / Meta */}
          <Grid item xs={12} md={4}>
            <SummaryCard
                data={data}
                extractedEff={extractedEff}
                scoresEff={scoresEff}
                decisionsEff={decisionsEff}
            />
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

/* ===== Summary + Hints ===== */
function SummaryCard({
                       data, extractedEff, scoresEff, decisionsEff
                     }: { data: any, extractedEff: any, scoresEff: any, decisionsEff: any }) {
  const finalsExtraction = Object.values(extractedEff ?? {});
  const finalsScoring = Object.values(scoresEff ?? {});
  const finalsDecision = Object.values(decisionsEff ?? {});

  const warnExtract = finalsExtraction.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;
  const warnScore = finalsScoring.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;
  const warnDec = finalsDecision.filter((x: any) => (x?.confidence ?? 1) < CONF_WARN).length;

  useEffect(() => {
    dlog("SummaryCard finals", {
      overall_score: data?.overall_score ?? null,
      extracted_count: finalsExtraction.length,
      scores_count: finalsScoring.length,
      decisions_count: finalsDecision.length,
      warnExtract, warnScore, warnDec
    });
  }, [data, finalsExtraction.length, finalsScoring.length, finalsDecision.length, warnExtract, warnScore, warnDec]);

  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Finale Zusammenfassung" subheader="Priorisierte Übersicht der Normalisierung & Scores" />
        <CardContent>
          <Stack spacing={1}>
            <Row label="Final Score">
              {typeof data?.overall_score === "number"
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

function HintsCard({ data }: { data: any }) {
  const lowExtraction = Object.values((data?.extracted ?? {}) as any).some((x: any) => x?.confidence < CONF_WARN);
  const lowScoring   = Object.values((data?.scores ?? {}) as any).some((x: any) => x?.confidence < CONF_WARN);
  const lowDecision  = Object.values((data?.decisions ?? {}) as any).some((x: any) => x?.confidence < CONF_WARN);

  useEffect(() => {
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
                  : "Alle finalen Ergebnisse liegen über der Konfidenzschwelle (oder Finals fehlen)."}
            </Typography>
            <Stack direction="row" alignItems="center" gap={1}>
              <InfoOutlinedIcon fontSize="small" color="action" />
              <Typography variant="caption" color="text.secondary">
                Tipp: Chips „Seite X“ springen direkt zur Fundstelle im PDF (neuer Tab).
              </Typography>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
  );
}

/* ===== Final Cards ===== */
function FinalExtractionCard({ extracted, pdfUrl }: { extracted?: Record<string, any>, pdfUrl: string }) {
  const entries = useMemo(() => Object.entries(extracted ?? {}), [extracted]);
  useEffect(() => { dlog("FinalExtractionCard", { count: entries.length, sample: entries.slice(0,3) }); }, [entries]);
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
                      <TableCell>{page ? <EvidenceChip page={page} pdfUrl={pdfUrl} bbox={bbox} quote={quote} /> : "—"}</TableCell>
                      <TableCell>{quote ? <Tooltip title={quote}><Typography noWrap sx={{ maxWidth: 360 }}>{quote}</Typography></Tooltip> : "—"}</TableCell>
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
  useEffect(() => { dlog("FinalScoringCard", { count: entries.length, sample: entries.slice(0,3) }); }, [entries]);
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
                      <TableCell><Chip size="small" color={v?.result ? "success" : "error"} label={v?.result ? "Ja" : "Nein"} /></TableCell>
                      <TableCell><ConfidenceBar value={v?.confidence} /></TableCell>
                      <TableCell>{(v?.votes_true ?? 0)} / {(v?.votes_false ?? 0)}</TableCell>
                      <TableCell>{v?.explanation ?? "—"}</TableCell>
                      <TableCell>
                        <Stack direction="row" gap={0.5} flexWrap="wrap">
                          {support.length ? support.map((s, i) => (
                              <EvidenceChip key={i} page={s.page!} pdfUrl={pdfUrl} bbox={s.bbox} quote={s.quote ?? undefined} />
                          )) : "—"}
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
  useEffect(() => { dlog("FinalDecisionCard", { count: entries.length, sample: entries.slice(0,3) }); }, [entries]);
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
                      <TableCell>{typeof v?.answer === "boolean" ? (<Chip size="small" color={v.answer ? "success" : "error"} label={v.answer ? "Ja" : "Nein"} />) : "—"}</TableCell>
                      <TableCell><ConfidenceBar value={v?.confidence} /></TableCell>
                      <TableCell>{typeof v?.votes_yes === "number" || typeof v?.votes_no === "number" ? `${v?.votes_yes ?? 0} / ${v?.votes_no ?? 0}` : "—"}</TableCell>
                      <TableCell>{v?.explanation ?? "—"}</TableCell>
                      <TableCell>
                        <Stack direction="row" gap={0.5} flexWrap="wrap">
                          {support.length ? support.map((s, i) => (
                              <EvidenceChip key={i} page={s.page!} pdfUrl={pdfUrl} bbox={s.bbox} quote={s.quote ?? undefined} />
                          )) : "—"}
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

/* ===== Drilldown ===== */
function PromptDrilldown({ data, pdfUrl }: { data: any, pdfUrl: string }) {
  const extraction = (data?.extraction as any[]) ?? [];
  const scoring = (data?.scoring as any[]) ?? [];
  const decision = (data?.decision as any[]) ?? [];

  const extractByPid = useMemo(() => groupByPid(extraction), [extraction]);
  const scoringByPid = useMemo(() => groupByPid(scoring), [scoring]);
  const decisionByPid = useMemo(() => groupByPid(decision), [decision]);

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
      pid: r?.prompt_id, value: r?.value, weight: r?.weight, page: r?.source?.page, err: r?.error
    })));
    dlog("Drilldown: sample scoring", summarizeArray(sc, r => ({
      pid: r?.prompt_id, result: r?.result, weight: r?.weight, page: r?.source?.page, err: r?.error
    })));
    dlog("Drilldown: sample decision", summarizeArray(dc, r => ({
      pid: r?.prompt_id, route: r?.route, bool: r?.boolean, weight: r?.weight, page: r?.source?.page, err: r?.error
    })));
  }, [extractByPid, scoringByPid, decisionByPid]);

  const [q, setQ] = useState("");
  const [onlyErr, setOnlyErr] = useState(false);
  const qlc = q.trim().toLowerCase();
  const match = (txt?: string | null) => (txt ?? "").toLowerCase().includes(qlc);
  const filterPR = <T extends PromptResult>(arr: T[]) => arr.filter((r: any) => {
    if (onlyErr && !r?.error) return false;
    if (!qlc) return true;
    const parts: string[] = [];
    if (r.prompt_text) parts.push(r.prompt_text);
    if (typeof r.value !== "object") parts.push(String(r.value ?? ""));
    if (r.route) parts.push(String(r.route));
    if (r.explanation) parts.push(String(r.explanation));
    if (r.source?.quote) parts.push(String(r.source.quote));
    return parts.some(p => match(p));
  });

  return (
      <Card variant="outlined">
        <CardHeader title="Evidenz pro Prompt" subheader="Batch-Ergebnisse (inkl. Seite/Zitat/BBox, Batch-Confidence falls vorhanden)" />
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
                              <TableCell>{r.source?.page ? <EvidenceChip page={r.source.page!} pdfUrl={pdfUrl} bbox={r.source?.bbox ?? undefined} quote={r.source?.quote ?? undefined} /> : "—"}</TableCell>
                              <TableCell>{r.source?.quote ? <Tooltip title={r.source.quote}><Typography noWrap sx={{ maxWidth: 360 }}>{r.source.quote}</Typography></Tooltip> : "—"}</TableCell>
                              <TableCell>{formatValue(r.value)}</TableCell>
                              <TableCell>{typeof r.weight === "number" ? <ConfidenceBar value={r.weight} /> : <Typography variant="body2">—</Typography>}</TableCell>
                              <TableCell>{r.json_key ?? "—"}</TableCell>
                              <TableCell>{Array.isArray(r.source?.bbox) ? <Tooltip title={String(r.source?.bbox)}><Chip size="small" label="BBox" variant="outlined" /></Tooltip> : "—"}</TableCell>
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
            const list = filterPR(items as PromptResult[]);
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
                              <TableCell>{s.source?.page ? <EvidenceChip page={s.source.page!} pdfUrl={pdfUrl} bbox={s.source?.bbox ?? undefined} quote={s.source?.quote ?? undefined} /> : "—"}</TableCell>
                              <TableCell>{s.result ? "Ja" : "Nein"}</TableCell>
                              <TableCell>{s.explanation || "—"}</TableCell>
                              <TableCell>{typeof s.weight === "number" ? <ConfidenceBar value={s.weight} /> : <Typography variant="body2">—</Typography>}</TableCell>
                              <TableCell>{Array.isArray(s.source?.bbox) ? <Tooltip title={String(s.source?.bbox)}><Chip size="small" label="BBox" variant="outlined" /></Tooltip> : "—"}</TableCell>
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
                              <TableCell>{r.source?.page ? <EvidenceChip page={r.source.page!} pdfUrl={pdfUrl} bbox={r.source?.bbox ?? undefined} quote={r.source?.quote ?? undefined} /> : "—"}</TableCell>
                              <TableCell>{r.route ?? "—"}</TableCell>
                              <TableCell>{typeof r.boolean === "boolean" ? (r.boolean ? "Ja" : "Nein") : "—"}</TableCell>
                              <TableCell>{r.explanation ?? (typeof r.value === "object" ? (r as any).value?.explanation : "—")}</TableCell>
                              <TableCell>{typeof r.weight === "number" ? <ConfidenceBar value={r.weight} /> : <Typography variant="body2">—</Typography>}</TableCell>
                              <TableCell>{Array.isArray(r.source?.bbox) ? <Tooltip title={String(r.source?.bbox)}><Chip size="small" label="BBox" variant="outlined" /></Tooltip> : "—"}</TableCell>
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

/* ===== Small helpers ===== */
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
  if (value == null || Number.isNaN(value)) return <Typography variant="body2">—</Typography>;
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

function groupByPid<T extends { prompt_id: number }>(arr: T[]): Record<number, T[]> {
  return (arr ?? []).reduce<Record<number, T[]>>((acc, cur) => {
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

/* ===== Deep diagnostics ===== */
function printRunDiagnostics(run: any, source: "localStorage" | "api") {
  dlog(`RUN (${source}) top-level`, {
    keys: keysOf(run),
    pdf_id: run?.pdf_id,
    pipeline_id: run?.pipeline_id,
    overall_score: run?.overall_score,
  });

  const exKeys = keysOf(run?.extracted);
  const scKeys = keysOf(run?.scores);
  const dcKeys = keysOf(run?.decisions);
  dlog("Finals present (exact keys)", { extracted_keys: exKeys, scores_keys: scKeys, decisions_keys: dcKeys });

  const exArr = run?.extraction ?? [];
  const scArr = run?.scoring ?? [];
  const dcArr = run?.decision ?? [];

  dlog("Arrays summary", {
    extraction: summarizeArray(exArr, (r: any) => ({ pid: r?.prompt_id, hasValue: r?.value != null, weight: r?.weight, page: r?.source?.page, err: r?.error })),
    scoring: summarizeArray(scArr, (r: any) => ({ pid: r?.prompt_id, result: r?.result, weight: r?.weight, page: r?.source?.page, err: r?.error })),
    decision: summarizeArray(dcArr, (r: any) => ({ pid: r?.prompt_id, route: r?.route, bool: r?.boolean, weight: r?.weight, page: r?.source?.page, err: r?.error })),
  });

  dlog("Weight presence", {
    extraction: countWeightPresence(exArr),
    scoring: countWeightPresence(scArr),
    decision: countWeightPresence(dcArr),
  });

  if (!exKeys.length && !scKeys.length && !dcKeys.length) {
    dlog("WARN: Keine finalen Maps gefunden", {
      tip: "DTO stammt wahrscheinlich vor der Konsolidierung ODER Feldnamen weichen ab (z. B. final_extracted/canonical_fields). Deep-Scan prüft verschachtelte Pfade.",
    });
  }
}
