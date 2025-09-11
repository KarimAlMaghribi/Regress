import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  AppBar,
  Badge,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  Grid,
  IconButton,
  InputAdornment,
  LinearProgress,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Tab,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import SearchIcon from "@mui/icons-material/Search";
import FilterListIcon from "@mui/icons-material/FilterList";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import VisibilityIcon from "@mui/icons-material/Visibility";
import DifferenceIcon from "@mui/icons-material/Difference";
import CloseIcon from "@mui/icons-material/Close";

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

type RunStep = {
  seq_no: number;
  step_id: string;
  prompt_id: number;
  prompt_type: PromptType;
  decision_key?: string | null;
  route?: string | null;
  result: any;
};

type PipelineRunResult = {
  pdf_id: number;
  pipeline_id: string;
  overall_score?: number | null;
  // Finale, konsolidierte Ergebnisse:
  extracted?: Record<string, { value: any; confidence: number; page?: number; quote?: string }>;
  scores?: Record<
      string,
      { result: boolean; confidence: number; votes_true?: number; votes_false?: number; support?: TextPosition[]; explanation?: string }
  >;
  decisions?: Record<string, { route: string; answer?: boolean | null; confidence: number; support?: TextPosition[]; explanation?: string }>;
  // Rohdaten (Batch-Ebene) – optional verfügbar:
  extraction?: PromptResult[];
  scoring?: ScoringResult[];
  decision?: PromptResult[];
  log?: RunStep[];
};

const CONF_WARN = 0.6;

/* -------------------------------------------------------
 * Hilfsfunktionen
 * -----------------------------------------------------*/
function clamp01(n?: number | null) {
  const v = typeof n === "number" ? n : 0;
  return Math.max(0, Math.min(1, v));
}

function formatValue(val: any) {
  if (val == null) return "—";
  if (typeof val === "number") return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(val);
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function prettyJSON(val: any) {
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // no-op
  }
}

function groupByPid<T extends { prompt_id: number }>(arr: T[]): Record<number, T[]> {
  return arr.reduce<Record<number, T[]>>((acc, cur) => {
    (acc[cur.prompt_id] ||= []).push(cur);
    return acc;
  }, {});
}

function toPercent(n?: number | null) {
  return `${Math.round(clamp01(n) * 100)}%`;
}

/** Ermittelt aus extraction[] eine Map json_key -> prompt_id */
function mapJsonKeyToPid(extraction?: PromptResult[]) {
  const map = new Map<string, number>();
  extraction?.forEach((e) => {
    if (e.json_key) map.set(e.json_key, e.prompt_id);
  });
  return map;
}

/** Ermittelt aus log[] eine Map decision_key -> prompt_id (falls vorhanden) */
function mapDecisionKeyToPid(log?: RunStep[]) {
  const map = new Map<string, number>();
  log?.forEach((s) => {
    if (s.prompt_type === "DecisionPrompt" && s.decision_key) {
      map.set(s.decision_key, s.prompt_id);
    }
  });
  return map;
}

function openSourceInPdf(pdfId: number, s?: TextPosition) {
  if (!s) return;
  const q = new URLSearchParams({
    page: String(s.page),
    bbox: JSON.stringify(s.bbox ?? []),
  });
  window.open(`/pdf/${pdfId}?${q.toString()}`, "_blank", "noopener,noreferrer");
}

/** Heuristik: finalen Key eines PIDs finden über json_key der Batch-Items; Fallback: _<pid>-Suffix */
function findFinalKeyByPid(
    extracted: PipelineRunResult["extracted"] | undefined,
    itemsForPid: PromptResult[]
): string | undefined {
  if (!extracted || !itemsForPid?.length) return undefined;
  const jsonKey = itemsForPid.find((i) => i.json_key)?.json_key;
  if (jsonKey && extracted[jsonKey]) return jsonKey;
  const pid = itemsForPid[0].prompt_id;
  const bySuffix = Object.keys(extracted).find((k) => k.endsWith(`_${pid}`));
  return bySuffix ?? Object.keys(extracted)[0];
}

/* -------------------------------------------------------
 * Evidenz-Navigator zum Scrollen auf ein Akkordeon
 * -----------------------------------------------------*/
function useEvidenceNavigator() {
  const accRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const register = (pid: number) => (el: HTMLDivElement | null) => (accRefs.current[pid] = el);
  const open = (pid?: number) => {
    if (!pid) return;
    accRefs.current[pid]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return { register, open };
}

/* -------------------------------------------------------
 * Hauptkomponente
 * -----------------------------------------------------*/
export default function RunDetailsPage() {
  const { id } = useParams();
  const [data, setData] = useState<PipelineRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Tabs
  const [tab, setTab] = useState<0 | 1 | 2>(0); // 0=Übersicht, 1=Evidenz, 2=Log

  // Filter-Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const [search, setSearch] = useState("");

  // Evidenz-Akkordeons
  const [expandAll, setExpandAll] = useState(true);
  const evidenceNav = useEvidenceNavigator();

  // Diff-Ansicht
  const [diffOpen, setDiffOpen] = useState(false);
  const [compareId, setCompareId] = useState<string>("");
  const [diffAgainst, setDiffAgainst] = useState<PipelineRunResult | null>(null);

  const fetchRun = useCallback(
      async (signal?: AbortSignal) => {
        if (!id) return;
        setErr(null);
        setLoading(true);
        try {
          const res = await fetch(`/runs/${id}`, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as PipelineRunResult;
          setData(json);
        } catch (e: any) {
          if (e?.name !== "AbortError") setErr(e?.message ?? "Fehler beim Laden");
        } finally {
          setLoading(false);
        }
      },
      [id]
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchRun(ac.signal);
    return () => ac.abort();
  }, [fetchRun]);

  const onReload = async () => {
    setReloading(true);
    try {
      await fetchRun();
    } finally {
      setReloading(false);
    }
  };

  const jsonKeyToPid = useMemo(() => mapJsonKeyToPid(data?.extraction), [data?.extraction]);
  const decisionKeyToPid = useMemo(() => mapDecisionKeyToPid(data?.log), [data?.log]);

  const extractionByPid = useMemo(() => groupByPid(data?.extraction ?? []), [data?.extraction]);
  const scoringByPid = useMemo(() => groupByPid(data?.scoring ?? []), [data?.scoring]);
  const decisionByPid = useMemo(() => groupByPid(data?.decision ?? []), [data?.decision]);

  const filteredExtractedEntries = useMemo(() => {
    const entries = Object.entries(data?.extracted ?? {});
    const filtered = entries.filter(([key, v]) => {
      const warnOk = !onlyWarnings || (v?.confidence ?? 1) < CONF_WARN;
      const q = search.trim().toLowerCase();
      const inKey = key.toLowerCase().includes(q);
      const inValue = formatValue(v.value).toLowerCase().includes(q);
      const inQuote = (v.quote ?? "").toLowerCase().includes(q);
      return warnOk && (!q || inKey || inValue || inQuote);
    });
    return filtered;
  }, [data?.extracted, onlyWarnings, search]);

  const filteredScoresEntries = useMemo(() => {
    const entries = Object.entries(data?.scores ?? {});
    const filtered = entries.filter(([key, v]) => {
      const warnOk = !onlyWarnings || (v?.confidence ?? 1) < CONF_WARN;
      const q = search.trim().toLowerCase();
      const inKey = key.toLowerCase().includes(q);
      const inText = (v.explanation ?? "").toLowerCase().includes(q);
      return warnOk && (!q || inKey || inText);
    });
    return filtered;
  }, [data?.scores, onlyWarnings, search]);

  const filteredDecisionEntries = useMemo(() => {
    const entries = Object.entries(data?.decisions ?? {});
    const filtered = entries.filter(([key, v]) => {
      const warnOk = !onlyWarnings || (v?.confidence ?? 1) < CONF_WARN;
      const q = search.trim().toLowerCase();
      const inKey = key.toLowerCase().includes(q);
      const inRoute = (v.route ?? "").toLowerCase().includes(q);
      const inExpl = (v.explanation ?? "").toLowerCase().includes(q);
      return warnOk && (!q || inKey || inRoute || inExpl);
    });
    return filtered;
  }, [data?.decisions, onlyWarnings, search]);

  // Diff: geänderte Keys in extracted/scores/decisions markieren
  const diffExtractedChanged = useMemo(() => {
    if (!data?.extracted || !diffAgainst?.extracted) return new Set<string>();
    const set = new Set<string>();
    for (const [k, v] of Object.entries(data.extracted)) {
      const o = diffAgainst.extracted[k];
      if (!o) continue;
      if (JSON.stringify(o.value) !== JSON.stringify(v.value) || Math.abs((o.confidence ?? 0) - (v.confidence ?? 0)) > 1e-9) {
        set.add(k);
      }
    }
    return set;
  }, [data?.extracted, diffAgainst?.extracted]);

  const diffScoresChanged = useMemo(() => {
    if (!data?.scores || !diffAgainst?.scores) return new Set<string>();
    const set = new Set<string>();
    for (const [k, v] of Object.entries(data.scores)) {
      const o = diffAgainst.scores[k];
      if (!o) continue;
      if (o.result !== v.result || Math.abs((o.confidence ?? 0) - (v.confidence ?? 0)) > 1e-9) {
        set.add(k);
      }
    }
    return set;
  }, [data?.scores, diffAgainst?.scores]);

  const diffDecisionsChanged = useMemo(() => {
    if (!data?.decisions || !diffAgainst?.decisions) return new Set<string>();
    const set = new Set<string>();
    for (const [k, v] of Object.entries(data.decisions)) {
      const o = diffAgainst.decisions[k];
      if (!o) continue;
      if (o.route !== v.route || (o.answer ?? null) !== (v.answer ?? null) || Math.abs((o.confidence ?? 0) - (v.confidence ?? 0)) > 1e-9) {
        set.add(k);
      }
    }
    return set;
  }, [data?.decisions, diffAgainst?.decisions]);

  const handleOpenCompare = () => setDiffOpen(true);
  const handleCloseCompare = () => setDiffOpen(false);
  const doCompare = async () => {
    if (!compareId) return;
    try {
      const res = await fetch(`/runs/${compareId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PipelineRunResult;
      setDiffAgainst(json);
      setDiffOpen(false);
      setTab(0);
    } catch (e) {
      // ignore
    }
  };

  const downloadJSON = () => {
    if (!data) return;
    const blob = new Blob([prettyJSON(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `run_${id}_${data.pipeline_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* -------------------- Render --------------------- */

  if (loading) {
    return (
        <Container maxWidth="xl" sx={{ py: 3 }}>
          <Stack gap={2}>
            <Stack direction="row" alignItems="center" gap={1}>
              <CircularProgress size={22} /> <Typography>Lade Run {id}…</Typography>
            </Stack>
            <Skeleton variant="rectangular" height={48} />
            <Skeleton variant="rectangular" height={160} />
            <Skeleton variant="rectangular" height={240} />
          </Stack>
        </Container>
    );
  }
  if (err) {
    return (
        <Container maxWidth="xl" sx={{ py: 3 }}>
          <Card variant="outlined">
            <CardHeader title="Fehler beim Laden" />
            <CardContent>
              <Stack direction="row" alignItems="center" gap={2}>
                <Typography color="error">{err}</Typography>
                <Button onClick={onReload} startIcon={<RefreshIcon />} variant="contained">
                  Erneut laden
                </Button>
              </Stack>
            </CardContent>
          </Card>
        </Container>
    );
  }
  if (!data) return null;

  const overall = clamp01(data.overall_score ?? null);

  return (
      <Container maxWidth="xl" sx={{ pb: 4 }}>
        {/* Sticky Header */}
        <Box
            sx={{
              position: "sticky",
              top: 0,
              zIndex: (t) => t.zIndex.appBar,
              bgcolor: "background.paper",
              borderBottom: 1,
              borderColor: "divider",
              py: 1.5,
              mb: 2,
            }}
        >
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
            <Stack direction="row" alignItems="center" gap={2}>
              <Box sx={{ position: "relative", display: "inline-flex" }}>
                <CircularProgress variant="determinate" value={overall * 100} size={44} color={overall >= 0.8 ? "success" : overall >= CONF_WARN ? "warning" : "error"} />
                <Box
                    sx={{
                      top: 0,
                      left: 0,
                      bottom: 0,
                      right: 0,
                      position: "absolute",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                >
                  <Typography variant="caption" component="div">
                    {toPercent(overall)}
                  </Typography>
                </Box>
              </Box>

              <Box>
                <Typography variant="h6">Run-Details</Typography>
                <Typography variant="body2" color="text.secondary">
                  Pipeline:&nbsp;
                  <Tooltip title="Kopieren">
                    <Chip
                        size="small"
                        variant="outlined"
                        label={data.pipeline_id}
                        onClick={() => copyToClipboard(data.pipeline_id)}
                        sx={{ cursor: "copy" }}
                    />
                  </Tooltip>
                  &nbsp;•&nbsp;PDF-ID:&nbsp;
                  <Tooltip title="Kopieren">
                    <Chip size="small" variant="outlined" label={data.pdf_id} onClick={() => copyToClipboard(String(data.pdf_id))} sx={{ cursor: "copy" }} />
                  </Tooltip>
                  {typeof data.overall_score === "number" ? <> &nbsp;•&nbsp;Overall: {overall.toFixed(2)}</> : null}
                </Typography>
              </Box>
            </Stack>

            <Stack direction="row" alignItems="center" gap={1}>
              <TextField
                  size="small"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Suchen…"
                  InputProps={{
                    startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" />
                        </InputAdornment>
                    ),
                  }}
                  sx={{ minWidth: 260 }}
              />
              <Tooltip title="Filter">
                <IconButton aria-label="Filter öffnen" onClick={() => setDrawerOpen(true)}>
                  <Badge color="warning" variant={onlyWarnings ? "dot" : "standard"}>
                    <FilterListIcon />
                  </Badge>
                </IconButton>
              </Tooltip>
              <Tooltip title="PDF öffnen">
              <span>
                <IconButton aria-label="PDF öffnen" onClick={() => window.open(`/pdf/${data.pdf_id}`, "_blank", "noopener,noreferrer")}>
                  <OpenInNewIcon />
                </IconButton>
              </span>
              </Tooltip>
              <Tooltip title="JSON exportieren">
                <IconButton aria-label="JSON exportieren" onClick={downloadJSON}>
                  <ContentCopyIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Run vergleichen">
                <IconButton aria-label="Run vergleichen" onClick={handleOpenCompare}>
                  <DifferenceIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Neu laden">
              <span>
                <IconButton aria-label="Neu laden" onClick={onReload} disabled={reloading}>
                  {reloading ? <CircularProgress size={18} /> : <RefreshIcon />}
                </IconButton>
              </span>
              </Tooltip>
            </Stack>
          </Stack>

          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mt: 1 }}>
            <Tab label="Übersicht" />
            <Tab label="Evidenz" />
            <Tab label="Log" />
          </Tabs>
        </Box>

        {/* Content */}
        {tab === 0 && (
            <Grid container spacing={2}>
              <Grid item xs={12} md={8} lg={8}>
                <FinalExtractionCard
                    pdfId={data.pdf_id}
                    entries={filteredExtractedEntries}
                    jsonKeyToPid={jsonKeyToPid}
                    onJumpToPid={(pid) => {
                      setTab(1);
                      setTimeout(() => evidenceNav.open(pid), 0);
                    }}
                    changedKeys={diffExtractedChanged}
                />
                <FinalScoringCard
                    entries={filteredScoresEntries}
                    // Jump bei Scoring ohne direkte Zuordnung weggelassen
                    changedKeys={diffScoresChanged}
                />
                <FinalDecisionCard
                    entries={filteredDecisionEntries}
                    decisionKeyToPid={decisionKeyToPid}
                    onJumpToPid={(pid) => {
                      setTab(1);
                      setTimeout(() => evidenceNav.open(pid), 0);
                    }}
                    changedKeys={diffDecisionsChanged}
                />
              </Grid>

              <Grid item xs={12} md={4} lg={4}>
                <HintsCard data={data} onlyWarnings={onlyWarnings} />
              </Grid>
            </Grid>
        )}

        {tab === 1 && (
            <EvidenceTab
                data={data}
                extractionByPid={extractionByPid}
                scoringByPid={scoringByPid}
                decisionByPid={decisionByPid}
                registerRef={evidenceNav.register}
                expandAll={expandAll}
                setExpandAll={setExpandAll}
                extractedFinal={data.extracted}
            />
        )}

        {tab === 2 && <LogTab log={data.log} />}

        {/* Filter Drawer */}
        <Drawer anchor="right" open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <Box sx={{ width: 320, p: 2 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography variant="h6">Filter</Typography>
              <IconButton aria-label="Schließen" onClick={() => setDrawerOpen(false)}>
                <CloseIcon />
              </IconButton>
            </Stack>
            <Divider sx={{ my: 1.5 }} />
            <Stack gap={2}>
              <Chip
                  label="Nur Warnungen (< 60%)"
                  color={onlyWarnings ? "warning" : "default"}
                  variant="outlined"
                  onClick={() => setOnlyWarnings((v) => !v)}
              />
              <TextField
                  label="Suche"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  InputProps={{
                    startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon />
                        </InputAdornment>
                    ),
                  }}
              />
              <Chip
                  label={expandAll ? "Alles einklappen" : "Alles ausklappen"}
                  variant="outlined"
                  onClick={() => setExpandAll((v) => !v)}
              />
            </Stack>
          </Box>
        </Drawer>

        {/* Compare Dialog */}
        <Dialog open={diffOpen} onClose={handleCloseCompare} maxWidth="xs" fullWidth>
          <DialogTitle>Run vergleichen</DialogTitle>
          <DialogContent>
            <TextField
                fullWidth
                autoFocus
                label="Vergleichs-Run-ID"
                value={compareId}
                onChange={(e) => setCompareId(e.target.value)}
                placeholder="z. B. 123"
                sx={{ mt: 1 }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={handleCloseCompare}>Abbrechen</Button>
            <Button onClick={doCompare} variant="contained" startIcon={<DifferenceIcon />}>
              Vergleichen
            </Button>
          </DialogActions>
        </Dialog>
      </Container>
  );
}

/* -------------------------------------------------------
 * UI-Bausteine
 * -----------------------------------------------------*/

function HintsCard({ data, onlyWarnings }: { data: PipelineRunResult; onlyWarnings: boolean }) {
  const lowExtraction = Object.values(data.extracted ?? {}).some((x) => (x?.confidence ?? 1) < CONF_WARN);
  const lowScoring = Object.values(data.scores ?? {}).some((x) => (x?.confidence ?? 1) < CONF_WARN);
  const lowDecision = Object.values(data.decisions ?? {}).some((x) => (x?.confidence ?? 1) < CONF_WARN);

  return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader title="Hinweise" />
        <CardContent>
          <Stack spacing={1}>
            <Typography variant="body2">
              <b>Overall:</b> {typeof data.overall_score === "number" ? clamp01(data.overall_score).toFixed(2) : "—"}
            </Typography>
            <Typography variant="body2">
              {lowExtraction || lowScoring || lowDecision
                  ? "⚠️ Einige finale Ergebnisse liegen unter der Konfidenzschwelle."
                  : "Alle finalen Ergebnisse liegen über der Konfidenzschwelle."}
            </Typography>
            {onlyWarnings && (
                <Typography variant="caption" color="text.secondary">
                  Filter aktiv: Es werden nur Warnungen angezeigt.
                </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              Tipp: Über das Auge-Symbol springst du direkt zur Evidenz.
            </Typography>
          </Stack>
        </CardContent>
      </Card>
  );
}

function FinalExtractionCard({
                               pdfId,
                               entries,
                               jsonKeyToPid,
                               onJumpToPid,
                               changedKeys,
                             }: {
  pdfId: number;
  entries: [string, NonNullable<PipelineRunResult["extracted"]>[string]][];
  jsonKeyToPid: Map<string, number>;
  onJumpToPid: (pid?: number) => void;
  changedKeys: Set<string>;
}) {
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
                <TableCell width={220}>Confidence</TableCell>
                <TableCell>Seite</TableCell>
                <TableCell>Zitat</TableCell>
                <TableCell align="right">Aktionen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([key, v]) => {
                const pid = jsonKeyToPid.get(key);
                const changed = changedKeys.has(key);
                return (
                    <TableRow key={key} hover sx={changed ? { bgcolor: "action.hover" } : undefined}>
                      <TableCell>
                        <Stack direction="row" alignItems="center" gap={1}>
                          <Chip size="small" label={key} />
                          {changed && <Chip size="small" color="info" variant="outlined" label="Geändert" />}
                        </Stack>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {formatValue(v.value)}
                      </TableCell>
                      <TableCell>
                        <ConfidenceBar value={v.confidence} />
                      </TableCell>
                      <TableCell>{v.page ?? "—"}</TableCell>
                      <TableCell sx={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {v.quote ?? "—"}
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" justifyContent="flex-end" gap={1}>
                          <Tooltip title="Wert kopieren">
                            <IconButton
                                aria-label="Wert kopieren"
                                size="small"
                                onClick={() => copyToClipboard(String(formatValue(v.value)))}
                            >
                              <ContentCopyIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="JSON kopieren">
                            <IconButton aria-label="JSON kopieren" size="small" onClick={() => copyToClipboard(prettyJSON(v))}>
                              <ContentCopyIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Quelle im PDF öffnen">
                        <span>
                          <IconButton
                              aria-label="Quelle im PDF öffnen"
                              size="small"
                              onClick={() => openSourceInPdf(pdfId, v.page ? { page: v.page, bbox: [], quote: v.quote } : undefined)}
                              disabled={!v.page}
                          >
                            <OpenInNewIcon fontSize="inherit" />
                          </IconButton>
                        </span>
                          </Tooltip>
                          <Tooltip title="Zur Evidenz springen">
                        <span>
                          <IconButton aria-label="Zur Evidenz springen" size="small" onClick={() => onJumpToPid(pid)} disabled={!pid}>
                            <VisibilityIcon fontSize="inherit" />
                          </IconButton>
                        </span>
                          </Tooltip>
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

function FinalScoringCard({
                            entries,
                            changedKeys,
                          }: {
  entries: [string, NonNullable<PipelineRunResult["scores"]>[string]][];
  changedKeys: Set<string>;
}) {
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
                <TableCell width={220}>Confidence</TableCell>
                <TableCell>Votes T/F</TableCell>
                <TableCell>Erklärung</TableCell>
                <TableCell align="right">Aktionen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([key, v]) => {
                const changed = changedKeys.has(key);
                return (
                    <TableRow key={key} hover sx={changed ? { bgcolor: "action.hover" } : undefined}>
                      <TableCell>
                        <Stack direction="row" alignItems="center" gap={1}>
                          <Chip size="small" label={key} />
                          {changed && <Chip size="small" color="info" variant="outlined" label="Geändert" />}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Chip size="small" color={v.result ? "success" : "error"} label={v.result ? "Ja" : "Nein"} />
                      </TableCell>
                      <TableCell>
                        <ConfidenceBar value={v.confidence} />
                      </TableCell>
                      <TableCell>
                        {(v.votes_true ?? 0)}/{(v.votes_false ?? 0)}
                      </TableCell>
                      <TableCell sx={{ maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {v.explanation ?? "—"}
                      </TableCell>
                      <TableCell align="right">
                        <Tooltip title="JSON kopieren">
                          <IconButton aria-label="JSON kopieren" size="small" onClick={() => copyToClipboard(prettyJSON(v))}>
                            <ContentCopyIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
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

function FinalDecisionCard({
                             entries,
                             decisionKeyToPid,
                             onJumpToPid,
                             changedKeys,
                           }: {
  entries: [string, NonNullable<PipelineRunResult["decisions"]>[string]][];
  decisionKeyToPid: Map<string, number>;
  onJumpToPid: (pid?: number) => void;
  changedKeys: Set<string>;
}) {
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
                <TableCell width={220}>Confidence</TableCell>
                <TableCell align="right">Aktionen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([key, v]) => {
                const pid = decisionKeyToPid.get(key);
                const changed = changedKeys.has(key);
                return (
                    <TableRow key={key} hover sx={changed ? { bgcolor: "action.hover" } : undefined}>
                      <TableCell>
                        <Stack direction="row" alignItems="center" gap={1}>
                          <Chip size="small" label={key} />
                          {changed && <Chip size="small" color="info" variant="outlined" label="Geändert" />}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Chip size="small" label={v.route} />
                      </TableCell>
                      <TableCell>
                        {typeof v.answer === "boolean" ? (
                            <Chip size="small" color={v.answer ? "success" : "error"} label={v.answer ? "Ja" : "Nein"} />
                        ) : (
                            "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <ConfidenceBar value={v.confidence} />
                      </TableCell>
                      <TableCell align="right">
                        <Tooltip title="JSON kopieren">
                          <IconButton aria-label="JSON kopieren" size="small" onClick={() => copyToClipboard(prettyJSON(v))}>
                            <ContentCopyIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Zur Evidenz springen">
                      <span>
                        <IconButton aria-label="Zur Evidenz springen" size="small" onClick={() => onJumpToPid(pid)} disabled={!pid}>
                          <VisibilityIcon fontSize="inherit" />
                        </IconButton>
                      </span>
                        </Tooltip>
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

function EvidenceTab({
                       data,
                       extractionByPid,
                       scoringByPid,
                       decisionByPid,
                       registerRef,
                       expandAll,
                       setExpandAll,
                       extractedFinal,
                     }: {
  data: PipelineRunResult;
  extractionByPid: Record<number, PromptResult[]>;
  scoringByPid: Record<number, ScoringResult[]>;
  decisionByPid: Record<number, PromptResult[]>;
  registerRef: (pid: number) => (el: HTMLDivElement | null) => void;
  expandAll: boolean;
  setExpandAll: React.Dispatch<React.SetStateAction<boolean>>;
  extractedFinal?: PipelineRunResult["extracted"];
}) {
  const extractionEntries = Object.entries(extractionByPid);
  const scoringEntries = Object.entries(scoringByPid);
  const decisionEntries = Object.entries(decisionByPid);

  return (
      <Card variant="outlined">
        <CardHeader
            title="Evidenz pro Prompt"
            subheader="Batch-Ergebnisse nach Prompt gruppiert"
            action={
              <Chip
                  label={expandAll ? "Alles einklappen" : "Alles ausklappen"}
                  variant="outlined"
                  onClick={() => setExpandAll((v) => !v)}
              />
            }
        />
        <CardContent>
          {/* Extraction */}
          {extractionEntries.map(([pidStr, items]) => {
            const pid = Number(pidStr);
            const finalKey = findFinalKeyByPid(extractedFinal, items);
            const finalVal = finalKey ? extractedFinal?.[finalKey] : undefined;

            return (
                <Accordion key={`ex-${pid}`} defaultExpanded ref={registerRef(pid)} expanded={expandAll}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography sx={{ flex: 1 }}>
                      Extraction #{pid} – {items[0]?.prompt_text ?? "Prompt"}
                    </Typography>
                    {finalVal && (
                        <Tooltip title={`Final: ${formatValue(finalVal.value)} • ${toPercent(finalVal.confidence)}`}>
                          <Chip
                              size="small"
                              label={`Final: ${formatValue(finalVal.value)} (${(finalVal.confidence ?? 0).toFixed(2)})`}
                              color={(finalVal.confidence ?? 1) < CONF_WARN ? "warning" : "default"}
                              sx={{ ml: 1 }}
                          />
                        </Tooltip>
                    )}
                  </AccordionSummary>
                  <AccordionDetails>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Seite</TableCell>
                          <TableCell>Zitat</TableCell>
                          <TableCell>Wert</TableCell>
                          <TableCell>Fehler</TableCell>
                          <TableCell align="right">Quelle</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {items.map((r, i) => (
                            <TableRow key={i} hover>
                              <TableCell>{r.source?.page ?? "—"}</TableCell>
                              <TableCell sx={{ maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {r.source?.quote ?? "—"}
                              </TableCell>
                              <TableCell sx={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {formatValue(r.value)}
                              </TableCell>
                              <TableCell>{r.error ?? ""}</TableCell>
                              <TableCell align="right">
                                <Tooltip title="Quelle im PDF öffnen">
                            <span>
                              <IconButton
                                  aria-label="Quelle im PDF öffnen"
                                  size="small"
                                  onClick={() => openSourceInPdf(data.pdf_id, r.source ?? undefined)}
                                  disabled={!r.source}
                              >
                                <OpenInNewIcon fontSize="inherit" />
                              </IconButton>
                            </span>
                                </Tooltip>
                              </TableCell>
                            </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionDetails>
                </Accordion>
            );
          })}

          {/* Scoring */}
          {scoringEntries.map(([pidStr, items]) => {
            const pid = Number(pidStr);
            return (
                <Accordion key={`sc-${pid}`} expanded={expandAll}>
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
                              <TableCell sx={{ maxWidth: 720, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {s.explanation || "—"}
                              </TableCell>
                            </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionDetails>
                </Accordion>
            );
          })}

          {/* Decision */}
          {decisionEntries.map(([pidStr, items]) => {
            const pid = Number(pidStr);
            return (
                <Accordion key={`dc-${pid}`} expanded={expandAll}>
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
                              <TableCell sx={{ maxWidth: 720, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {r.value && typeof r.value === "object" && "explanation" in r.value ? (r.value as any).explanation : "—"}
                              </TableCell>
                            </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionDetails>
                </Accordion>
            );
          })}

          {!extractionEntries.length && !scoringEntries.length && !decisionEntries.length && (
              <Card variant="outlined" sx={{ mt: 2 }}>
                <CardHeader title="Evidenz" subheader="Keine Batch-Listen verfügbar (älterer Run oder Rohdaten ausgeblendet)." />
                <CardContent>
                  <Typography variant="body2" color="text.secondary">
                    Finale Ergebnisse sind oben sichtbar. Für Audit-Daten (Batch-Ebene) bitte einen aktuellen Run öffnen.
                  </Typography>
                </CardContent>
              </Card>
          )}
        </CardContent>
      </Card>
  );
}

function LogTab({ log }: { log?: RunStep[] }) {
  if (!log?.length) {
    return (
        <Card variant="outlined">
          <CardHeader title="Log" subheader="Keine Logeinträge verfügbar." />
        </Card>
    );
  }
  return (
      <Card variant="outlined">
        <CardHeader title="Log" subheader="Ablauf der Schritte" />
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Typ</TableCell>
                <TableCell>Prompt-ID</TableCell>
                <TableCell>Decision-Key</TableCell>
                <TableCell>Route</TableCell>
                <TableCell>Result (Kurz)</TableCell>
                <TableCell align="right">JSON</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {log.map((s) => (
                  <TableRow key={`${s.seq_no}-${s.step_id}`} hover>
                    <TableCell>{s.seq_no}</TableCell>
                    <TableCell>{s.prompt_type}</TableCell>
                    <TableCell>{s.prompt_id}</TableCell>
                    <TableCell>{s.decision_key ?? "—"}</TableCell>
                    <TableCell>{s.route ?? "—"}</TableCell>
                    <TableCell sx={{ maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {typeof s.result === "object" ? JSON.stringify(s.result) : String(s.result)}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="JSON kopieren">
                        <IconButton aria-label="JSON kopieren" size="small" onClick={() => copyToClipboard(prettyJSON(s))}>
                          <ContentCopyIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

/* -------------------------------------------------------
 * Kleine UI-Helfer
 * -----------------------------------------------------*/

function ConfidenceBar({ value }: { value?: number }) {
  const v = clamp01(value);
  const color = v >= 0.8 ? "success" : v >= CONF_WARN ? "warning" : "error";
  return (
      <Tooltip title={toPercent(v)}>
        <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 180 }}>
          <Box sx={{ flex: 1 }}>
            <LinearProgress variant="determinate" value={v * 100} color={color as any} />
          </Box>
          <Typography variant="caption" sx={{ width: 40, textAlign: "right" }}>
            {toPercent(v)}
          </Typography>
        </Stack>
      </Tooltip>
  );
}
