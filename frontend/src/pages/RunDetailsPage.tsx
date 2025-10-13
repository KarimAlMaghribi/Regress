import * as React from "react";
import {useMemo} from "react";
import {useParams, useSearchParams} from "react-router-dom";
import {
  Alert,
  Box,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogContent,
  DialogTitle,
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
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ArticleIcon from "@mui/icons-material/Article"; // Extraktion
import RuleIcon from "@mui/icons-material/Rule"; // Bewertung (Scoring)
import AltRouteIcon from "@mui/icons-material/AltRoute"; // Entscheidung
import AssessmentIcon from "@mui/icons-material/Assessment"; // Übersicht
import CloseIcon from "@mui/icons-material/Close";

import {type RunDetail, type RunStep, type TernaryLabel, useRunDetails} from "../hooks/useRunDetails";
import {computeWeightedScore, scoreColor, ScoringWeightsCard} from "../components/ScoringWeightsCard";
import PdfViewer from "../components/PdfViewer";

/* ===== Helfer ===== */
const clamp01 = (n?: number | null) => Math.max(0, Math.min(1, Number.isFinite(n as number) ? (n as number) : 0));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const fmtNum = (n: number) => Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(n);

function valOrObjValue(v: any) {
  return v && typeof v === "object" && "value" in v ? (v as any).value : v;
}

function asBool(v: unknown) {
  if (typeof v === "boolean") return v;
  if (v && typeof v === "object" && "value" in (v as any)) return !!(v as any).value;
  return undefined;
}

function getAttemptPage(a: any): number | undefined {
  return a?.candidate_value?.page ?? a?.candidate_value?.source?.page ?? a?.candidate_value?.page_no;
}

/** ===== Neu: Hilfen für Seiten-Spannen (Batches) ===== **/
function pagesSpanFromBatch(batch: any): { start: number; end: number } | undefined {
  const raw: number[] = Array.isArray(batch?.pages) ? batch.pages.slice() : [];
  if (!raw.length) return undefined;
  raw.sort((a, b) => a - b);
  // Log nutzt 0-basierte Seiten → für UI auf 1-basiert mappen
  return { start: raw[0] + 1, end: raw[raw.length - 1] + 1 };
}

// Versuche das passende Log-Item zum Step zu finden (primär über final_key → prompt_id)
function findLogForStep(detail: RunDetail, step: RunStep): any | undefined {
  const logs: any[] = (detail as any)?.run?.log ?? (detail as any)?.log ?? [];
  if (!Array.isArray(logs) || logs.length === 0) return undefined;

  // Versuch 1: final_key wie "score_7" / "decision_3" → prompt_id
  const key = (step as any)?.final_key ?? (step as any)?.definition?.json_key ?? "";
  let pid: number | undefined;
  const m = typeof key === "string" ? key.match(/_(\d+)$/) : null;
  if (m) pid = Number(m[1]);

  const wantType =
      step.step_type === "Score"
          ? "ScoringPrompt"
          : step.step_type === "Decision"
              ? "DecisionPrompt"
              : "ExtractionPrompt";

  if (pid != null) {
    const byPid = logs.find(l => l?.prompt_id === pid && l?.prompt_type === wantType);
    if (byPid) return byPid;
  }

  // Versuch 2: Wenn es nur ein Log dieses Typs gibt
  const candidates = logs.filter(l => l?.prompt_type === wantType);
  if (candidates.length === 1) return candidates[0];

  return undefined;
}

function batchPageSpanForAttempt(detail: RunDetail, step: RunStep, attemptNo1: number): { start: number; end: number } | undefined {
  const log = findLogForStep(detail, step);
  const batch = (log as any)?.result?.batches?.[attemptNo1 - 1];
  return pagesSpanFromBatch(batch);
}

function extractAttemptConfidence(attempt: any): number | undefined {
  if (typeof attempt?.confidence === "number") return attempt.confidence;
  if (typeof attempt?.candidate_confidence === "number") return attempt.candidate_confidence;
  if (typeof attempt?.candidate_value?.confidence === "number") return attempt.candidate_value.confidence;
  return undefined;
}

function attemptEvidenceMeta(
    detail: RunDetail,
    step: RunStep,
    attempt: any,
    attemptIndex0: number
): {
  attemptNo: number;
  hasEvidence: boolean;
  label: string;
  pageToOpen?: number;
} {
  const attemptNo = (attempt?.attempt_no ?? attemptIndex0 + 1) as number;
  const pageExact = getAttemptPage(attempt);
  const span = pageExact == null ? batchPageSpanForAttempt(detail, step, attemptNo) : undefined;
  const hasEvidence = typeof pageExact === "number" || !!span;
  const label =
      typeof pageExact === "number"
          ? `📄 Seite ${pageExact}`
          : span
              ? (span.start === span.end ? `📄 Seite ${span.start}` : `📄 Seiten ${span.start}–${span.end}`)
              : "—";
  const pageToOpen = typeof pageExact === "number" ? pageExact : span?.start;

  return {attemptNo, hasEvidence, label, pageToOpen};
}

/* ===== bestehende Helper ===== */
function resolvePdfUrl(raw?: string | null, pdfId?: number | null): string | undefined {
  const ipBase = "http://192.168.130.102:8081";
  if (raw && typeof raw === "string") {
    // Host „pdf-ingest“ -> IP normalisieren
    return raw.replace("http://pdf-ingest:8081", ipBase);
  }
  if (pdfId != null) return `${ipBase}/pdf/${pdfId}`;
  return undefined;
}

function normFromScore(score?: number | null): number | undefined {
  if (typeof score !== "number") return undefined;
  return clamp01((clamp(score, -1, 1) + 1) / 2);
}

function voteChip(v?: TernaryLabel) {
  if (v === "yes")   return <Chip size="small" color="success" label="🟢 Ja" />;
  if (v === "no")    return <Chip size="small" color="error"   label="🔴 Nein" />;
  if (v === "unsure")return <Chip size="small"                 label="⚪ Unsicher" />;
  return <Chip size="small" variant="outlined" label="—" />;
}

/* Prompts hübsch anzeigen: Unterstriche entfernen, ellipsieren, Hover = Volltext */
function prettyPromptName(name?: string | null) {
  if (typeof name !== "string" || name.trim() === "") return "—";
  return name.replace(/_/g, " ").trim();
}

function PromptName({name, maxWidth = 260}: {name?: string | null; maxWidth?: number}) {
  const full = prettyPromptName(name);
  return (
      <Tooltip title={full}>
        <Box sx={{maxWidth, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
          {full}
        </Box>
      </Tooltip>
  );
}

/* Laufzeit formatieren */
function formatRuntime(start?: string | null, end?: string | null) {
  const ds = start ? new Date(start) : undefined;
  const de = end ? new Date(end) : undefined;
  if (!ds || !de || Number.isNaN(ds.getTime()) || Number.isNaN(de.getTime())) return "—";
  const ms = Math.max(0, de.getTime() - ds.getTime());
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ===== kleine UI-Bausteine ===== */

function StatusChip({status}: {status?: string | null }) {
  const map: Record<string, {
    color: "default" | "success" | "error" | "warning" | "info";
    icon: React.ReactNode;
    label: string
  }> = {
    queued: {color: "info", icon: <HourglassEmptyIcon fontSize="small"/>, label: "Wartend"},
    running: {color: "warning", icon: <PlayArrowIcon fontSize="small"/>, label: "Laufend"},
    finalized: {color: "success", icon: <CheckCircleOutlineIcon fontSize="small"/>, label: "Final"},
    completed: {color: "success", icon: <CheckCircleOutlineIcon fontSize="small"/>, label: "Abgeschlossen"},
    failed: {color: "error", icon: <ErrorOutlineIcon fontSize="small"/>, label: "Fehler"},
    timeout: {color: "error", icon: <ErrorOutlineIcon fontSize="small"/>, label: "Timeout"},
    canceled: {color: "default", icon: <ErrorOutlineIcon fontSize="small"/>, label: "Abgebrochen"},
  };
  const c = status ? map[status] : undefined;
  return <Chip size="small" color={c?.color ?? "default"} icon={c?.icon}
               label={c?.label ?? (status ?? "–")}/>;
}

function StepTypeIcon({t}: { t: RunStep["step_type"] }) {
  if (t === "Extraction") return <ArticleIcon sx={{color: "primary.main"}} fontSize="small"/>;
  if (t === "Score") return <RuleIcon sx={{color: "success.main"}} fontSize="small"/>;
  if (t === "Decision") return <AltRouteIcon sx={{color: "warning.main"}} fontSize="small"/>;
  return null;
}

function ConfidenceBar({value}: { value?: number | null }) {
  if (value == null || Number.isNaN(value)) return <Typography variant="body2">—</Typography>;
  const v = clamp01(value);
  return (
      <Stack direction="row" alignItems="center" gap={1} sx={{minWidth: 160}}>
        <Box sx={{flex: 1}}>
          <LinearProgress variant="determinate" value={v * 100}/>
        </Box>
        <Typography variant="caption" sx={{width: 40, textAlign: "right"}}>
          {(v * 100).toFixed(0)}%
        </Typography>
      </Stack>
  );
}

function formatValue(val: any) {
  const v = valOrObjValue(val);
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "✅ Ja" : "❌ Nein";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ===== Evidence-Modal ===== */

function EvidenceModal({
                         open, onClose, page, pdfUrl, detail, onChangePage
                       }: {
  open: boolean;
  onClose: () => void;
  page?: number;
  pdfUrl?: string;
  detail: RunDetail;
  onChangePage?: (p: number) => void;
}) {
  const current = page ?? 1;

  const byPage = React.useMemo(() => {
    const items = { extraction: [] as any[], scoring: [] as any[], decision: [] as any[] };

    (detail.steps ?? []).forEach(s => {
      (s.attempts ?? []).forEach(a => {
        const p = getAttemptPage(a);
        if (!page || p === page) {
          const row = { step: s, attempt: a };
          if (s.step_type === "Extraction") items.extraction.push(row);
          else if (s.step_type === "Score") items.scoring.push(row);
          else if (s.step_type === "Decision") items.decision.push(row);
        }
      });
    });

    const byKey = (r: any) => r.step.final_key ?? r.step.definition?.json_key ?? "";
    items.extraction.sort((a, b) => byKey(a).localeCompare(byKey(b)));
    items.scoring.sort((a, b) => byKey(a).localeCompare(byKey(b)));
    items.decision.sort((a, b) => byKey(a).localeCompare(byKey(b)));
    return items;
  }, [detail, page]);

  return (
      <Dialog open={open} onClose={onClose} maxWidth="xl" fullWidth>
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          📄 Seite
          <IconButton
              size="small"
              onClick={() => onChangePage?.(Math.max(1, current - 1))}
              disabled={current <= 1}
          >
            ‹
          </IconButton>
          <input
              type="number"
              value={current}
              onChange={e => onChangePage?.(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 64 }}
          />
          <IconButton size="small" onClick={() => onChangePage?.(current + 1)}>›</IconButton>
          <Box sx={{ flex: 1 }} />
          <IconButton size="small" onClick={onClose}><CloseIcon /></IconButton>
        </DialogTitle>

        <DialogContent dividers sx={{ p: 0 }}>
          <Box sx={{ display: "flex", height: "80vh" }}>
            {/* Links: PDF */}
            <Box sx={{ flex: 1, minWidth: 0, borderRight: theme => `1px solid ${theme.palette.divider}` }}>
              {pdfUrl ? (
                  <PdfViewer
                      url={pdfUrl}
                      page={current}
                      onPageChange={p => onChangePage?.(p)}   // ← Scroll im Viewer → synchronisiert rechte Seite
                      mode="scroll"
                      height="80vh"
                  />
              ) : (
                  <Stack sx={{ height: "100%" }} alignItems="center" justifyContent="center">
                    <Typography variant="body2" color="text.secondary">Kein PDF verfügbar</Typography>
                  </Stack>
              )}
            </Box>

            {/* Rechts: Ergebnisse für diese Seite */}
            <Box sx={{ width: 480, p: 2, overflowY: "auto" }}>
              <Typography variant="subtitle1" sx={{ mb: 1 }}>Ergebnisse auf dieser Seite</Typography>

              {/* Extraktion */}
              <Section title="🧩 Extraktion">
                {byPage.extraction.length === 0 ? <EmptyLine /> :
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Feld</TableCell>
                          <TableCell>Wert</TableCell>
                          <TableCell width={60}>Final</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {byPage.extraction.map((r, i) => (
                            <TableRow key={i} hover>
                              <TableCell>
                                <PromptName name={r.step.final_key ?? r.step.definition?.json_key ?? "—"} />
                              </TableCell>
                              <TableCell>{formatValue(r.attempt.candidate_value)}</TableCell>
                              <TableCell>{r.attempt.is_final ? "⭐" : "—"}</TableCell>
                            </TableRow>
                        ))}
                      </TableBody>
                    </Table>}
              </Section>

              {/* Bewertung (Scoring) */}
              <Section title="🟢 Bewertung">
                {byPage.scoring.length === 0 ? <EmptyLine /> :
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Regel</TableCell>
                          <TableCell>Stimme</TableCell>
                          <TableCell width={60}>Final</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {byPage.scoring.map((r, i) => {
                          const vote: TernaryLabel | undefined = r?.attempt?.vote
                              ?? (typeof r?.attempt?.candidate_value?.value === "string"
                                  ? r.attempt.candidate_value.value
                                  : undefined);
                          const chip = voteChip(vote);
                          return (
                              <TableRow key={i} hover>
                                <TableCell>
                                  <PromptName name={r.step.final_key ?? r.step.definition?.json_key ?? "—"} />
                                </TableCell>
                                <TableCell>{chip}</TableCell>
                                <TableCell>{r.attempt.is_final ? "⭐" : "—"}</TableCell>
                              </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>}
              </Section>

              {/* Entscheidung */}
              <Section title="⚖️ Entscheidung">
                {byPage.decision.length === 0 ? <EmptyLine /> :
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Frage</TableCell>
                          <TableCell>Stimme</TableCell>
                          <TableCell width={60}>Final</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {byPage.decision.map((r, i) => {
                          const v = asBool(r.attempt.candidate_value);
                          return (
                              <TableRow key={i} hover>
                                <TableCell>
                                  <PromptName name={r.step.final_key ?? r.step.definition?.json_key ?? "—"} />
                                </TableCell>
                                <TableCell>{v ? "✅ Ja" : "❌ Nein"}</TableCell>
                                <TableCell>{r.attempt.is_final ? "⭐" : "—"}</TableCell>
                              </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>}
              </Section>
            </Box>
          </Box>
        </DialogContent>
      </Dialog>
  );
}

function Section({title, children}: { title: string; children: React.ReactNode }) {
  return (
      <Box sx={{mb: 2}}>
        <Typography variant="subtitle2" sx={{mb: .5}}>{title}</Typography>
        {children}
      </Box>
  );
}

function EmptyLine() {
  return <Typography variant="body2" color="text.secondary">— keine Einträge —</Typography>;
}

/* ===== Seite ===== */

export default function RunDetailsPage() {
  const params = useParams<{ id?: string; key?: string }>();
  const [sp] = useSearchParams();

  const key = params.key || params.id || undefined;
  const runId = sp.get("run_id") || sp.get("id") || undefined;
  const rawPdf = sp.get("pdf") || sp.get("pdf_url") || undefined;

  const pdfId = (() => {
    const qp = sp.get("pdf_id");
    if (qp && /^\d+$/.test(qp)) return Number(qp);
    try {
      const LS_PREFIX = "run-view:";
      const storageKey = key ? `${LS_PREFIX}${key}` : undefined;
      if (!storageKey) return undefined;
      const raw = localStorage.getItem(storageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.pdfId === "number") return parsed.pdfId;
      if (typeof parsed?.run?.pdf_id === "number") return parsed.run.pdf_id;
    } catch {}
    return undefined;
  })();

  const {data, loading, error, scoreSum} =
      useRunDetails(runId, {pdfId, storageKey: key ? `run-view:${key}` : undefined});

  // ► PDF-URL auf IP normalisieren
  const resolvedPdfUrl = resolvePdfUrl(rawPdf ?? undefined, data?.run?.pdf_id);

  // Modal-Zustand
  const [modalOpen, setModalOpen] = React.useState(false);
  const [modalPage, setModalPage] = React.useState<number | undefined>(undefined);
  const openEvidence = (page?: number) => {
    setModalPage(page);
    setModalOpen(true);
  };
  const closeEvidence = () => setModalOpen(false);

  if (loading) {
    return (
        <Container maxWidth="xl" sx={{py: 3}}>
          <Stack direction="row" gap={1} alignItems="center">
            <CircularProgress size={22}/> <Typography>Lade Details…</Typography>
          </Stack>
        </Container>
    );
  }
  if (error) {
    return (
        <Container maxWidth="xl" sx={{py: 3}}>
          <Alert severity="error" sx={{mb: 2}}>{error.message}</Alert>
          <Typography variant="body2" color="text.secondary">
            Prüfe die URL-Parameter (<code>?run_id=&lt;UUID&gt;</code>) oder lade die Seite neu.
          </Typography>
        </Container>
    );
  }
  if (!data) return null;

  return (
      <Container maxWidth="xl" sx={{py: 3}}>
        <HeaderBar detail={data} pdfUrl={resolvedPdfUrl}/>
        <Stack spacing={2}>
          <SummaryCard detail={data} scoreSum={scoreSum}/>
          <ExtractionCard detail={data} pdfUrl={resolvedPdfUrl} onOpenEvidence={openEvidence}/>
          {/* Gewichte/aggregierter Score (optional, rendert evtl. nichts wenn keine Gewichte/FinalScores) */}
          <ScoringWeightsCard detail={data}/>
          {/* Immer als Fallback anzeigen, sobald Score-Steps existieren */}
          <ScoreBreakdownCard detail={data} onOpenEvidence={openEvidence}/>
          <DetailedResultFindingCard detail={data} onOpenEvidence={openEvidence}/>
          <StepsOverview detail={data}/>
        </Stack>

        {/* Modal */}
        <EvidenceModal
            open={modalOpen}
            onClose={closeEvidence}
            page={modalPage}
            pdfUrl={resolvedPdfUrl}
            detail={data}
            onChangePage={(p:number)=>setModalPage(p)}
        />
      </Container>
  );
}

/* ===== Kopf / Übersicht ===== */

function HeaderBar({detail, pdfUrl}: { detail: RunDetail; pdfUrl?: string }) {
  const {run} = detail;
  return (
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{mb: 1}}>
        <Box>
          <Typography variant="h5">Analyse · Run</Typography>
          <Typography variant="body2" color="text.secondary">
            Pipeline: {run.pipeline_id} • PDF-ID: {run.pdf_id} • Status: <StatusChip status={run.status}/>
          </Typography>
        </Box>
        <Stack direction="row" gap={1}>
          {pdfUrl && (
              <Tooltip title="PDF in neuem Tab öffnen">
                <IconButton size="small" onClick={() => window.open(pdfUrl!, "_blank", "noopener,noreferrer")}>
                  <OpenInNewIcon fontSize="small"/>
                </IconButton>
              </Tooltip>
          )}
          <Tooltip title="Neu laden">
            <IconButton size="small" onClick={() => window.location.reload()}>
              <RefreshIcon fontSize="small"/>
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
  );
}

function SummaryCard({ detail, scoreSum }: { detail: RunDetail; scoreSum: number }) {
  const { run } = detail;
  const finalKeys = Object.keys(run.final_extraction ?? {});
  const decKeys   = Object.keys(run.final_decisions ?? {});
  const scKeys    = Object.keys(run.final_scores ?? {});

  // 1) Versuche weiterhin computeWeightedScore zu nutzen (falls im Projekt bereits erweitert)
  const weighted = scKeys.length > 0 ? computeWeightedScore(detail) : null;

  // 2) Tri‑State‑Fallback: falls irgendein Score <0 oder >1 → (−1..+1) → 0..1 normalisieren
  const hasTri = scKeys.some(k => {
    const v = run.final_scores?.[k];
    return typeof v === "number" && (v < 0 || v > 1);
  });

  const triAvg = React.useMemo(() => {
    if (!hasTri) return null;
    const vals = scKeys
    .map(k => run.final_scores?.[k])
    .filter((v): v is number => typeof v === "number");
    if (!vals.length) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return normFromScore(mean) ?? null;
  }, [hasTri, scKeys.join("|"), run.final_scores]);

  const rawScore =
      triAvg != null
          ? triAvg
          : typeof weighted === "number"
              ? weighted
              : typeof run.overall_score === "number"
                  ? run.overall_score
                  : null;

  const scoreValue = rawScore != null ? clamp01(rawScore) : null;
  const scorePercent = scoreValue != null ? scoreValue * 100 : null;
  const scoreTone = scoreValue != null ? scoreColor(scoreValue) : "text.secondary";

  const runtime = formatRuntime(detail.run.started_at, detail.run.finished_at);

  return (
      <Card variant="outlined">
        <CardHeader
            title="Übersicht"
            subheader={
              scorePercent != null ? (
                  <Stack spacing={0.25}>
                    <Typography variant="subtitle2" sx={{ color: scoreTone, fontWeight: 600 }}>
                      Gesamtscore: {scorePercent!.toFixed(0)}%
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Konsolidierte Ergebnisse & Score
                    </Typography>
                  </Stack>
              ) : "Konsolidierte Ergebnisse & Score"
            }
        />
        <CardContent>
          <Stack spacing={1.5}>
            {/* Gesamtscore zentral */}
            <Box sx={{display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center"}}>
              {scoreValue != null ? (
                  <Stack alignItems="center" spacing={1} sx={{width: "100%", maxWidth: 540}}>
                    <Typography variant="body2" color="text.secondary">Gesamtscore</Typography>
                    <LinearProgress
                        variant="determinate"
                        value={scorePercent!}
                        sx={{
                          width: "100%",
                          '& .MuiLinearProgress-bar': { bgcolor: scoreTone },
                        }}
                    />
                    <Typography variant="h5" sx={{ color: scoreTone, fontWeight: 600 }}>
                      {scorePercent!.toFixed(0)}%
                    </Typography>
                  </Stack>
              ) : (
                  <Typography variant="body2">—</Typography>
              )}
            </Box>

            <Row label="Extrakte">🧩 {finalKeys.length} Felder</Row>
            <Row label="Entscheidungen">⚖️ {decKeys.length} Einträge</Row>
            <Row label="Score-Regeln">
              🟢 {scKeys.length} Regeln • Summe: {fmtNum(scoreSum)} {hasTri && <Typography component="span" variant="caption" color="text.secondary"> (Tri‑State Σ)</Typography>}
            </Row>

            <Divider sx={{ my: 1 }} />

            <Row label="Laufzeit">⏱️ {runtime}</Row>

            {detail.run.error && (
                <Row label="Fehler">
                  <Chip size="small" color="error" icon={<ErrorOutlineIcon />} label={detail.run.error} />
                </Row>
            )}
          </Stack>
        </CardContent>
      </Card>
  );
}

/* ===== Karten ===== */

function ExtractionCard({
                          detail, pdfUrl, onOpenEvidence
                        }: {
  detail: RunDetail;
  pdfUrl?: string;
  onOpenEvidence: (page?: number) => void
}) {
  const map = detail.run.final_extraction ?? {};
  const entries = useMemo(() => Object.entries(map), [map]);

  const confByKey = useMemo(() => {
    const m = new Map<string, number>();
    (detail.steps ?? []).forEach(s => {
      if (s.step_type === "Extraction" && s.final_key && typeof s.final_confidence === "number") {
        m.set(s.final_key, s.final_confidence);
      }
    });
    return m;
  }, [detail.steps]);

  if (!entries.length) return null;

  return (
      <Card variant="outlined">
        <CardHeader title="Finale Extraktion" subheader="Konsolidierte Felder"/>
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Feld</TableCell>
                <TableCell>Wert</TableCell>
                <TableCell width={180} align="right">Konfidenz</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell>
                      <PromptName name={k}/>
                    </TableCell>
                    <TableCell>{formatValue(v)}</TableCell>
                    <TableCell align="right"><ConfidenceBar value={confByKey.get(k)}/></TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

function ScoreBreakdownCard({detail, onOpenEvidence}: {
  detail: RunDetail;
  onOpenEvidence: (page?: number) => void
}) {
  const scoreSteps = (detail.steps ?? []).filter(s => s.step_type === "Score");
  if (!scoreSteps.length) return null;

  const scoreByKey: Record<string, number | undefined> = detail.run.final_scores ?? {};

  return (
      <Card variant="outlined">
        <CardHeader title="Bewertungs-Details" subheader="Alle Regeln, Stimmen & Evidenzen" />
        <CardContent>
          <Stack spacing={2}>
            {scoreSteps.map((s, idx) => {
              const rawScore = typeof s.final_key === "string" ? scoreByKey[s.final_key] : undefined;
              const norm = normFromScore(rawScore);
              const lbl = s.final_score_label as TernaryLabel | undefined;

              return (
                  <Box key={s.id}>
                    <Stack direction="row" alignItems="center" gap={1} sx={{mb: 0.5}}>
                      <RuleIcon sx={{color: (lbl === "yes" ? "success.main" : lbl === "no" ? "error.main" : "text.secondary")}} fontSize="small"/>
                      <Typography variant="subtitle2" sx={{display: "flex", alignItems: "center", gap: .5}}>
                        <PromptName name={s.final_key ?? `Regel ${idx + 1}`} />
                        · Ergebnis:&nbsp;
                        {lbl ? voteChip(lbl) : (typeof s.final_value === "boolean" ? (s.final_value ? "✅ Ja" : "❌ Nein") : "—")}
                      </Typography>
                      <Box sx={{flex: 1}}/>
                      {/* Zeige Tri‑State‑Score als Balken (−1..+1 → 0..1), falls vorhanden */}
                      {typeof norm === "number" ? (
                          <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 200 }}>
                            <LinearProgress variant="determinate" value={norm * 100}/>
                            <Typography variant="caption" sx={{width: 40, textAlign: "right"}}>{fmtNum(norm)}</Typography>
                          </Stack>
                      ) : (
                          <ConfidenceBar value={s.final_confidence}/>
                      )}
                    </Stack>

                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell width={56}>#</TableCell>
                          <TableCell>Erklärung</TableCell>
                          <TableCell width={120}>Stimme</TableCell>
                          <TableCell width={160}>Evidenz</TableCell>
                          <TableCell width={90}>Final</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {(s.attempts ?? []).map((a, i) => {
                          const pageExact = getAttemptPage(a);
                          const attemptNo = (a?.attempt_no ?? i + 1) as number;
                          const span = pageExact == null ? batchPageSpanForAttempt(detail, s, attemptNo) : undefined;

                          const vote: TernaryLabel | undefined =
                              a?.vote ?? (typeof a?.candidate_value?.value === "string" ? a.candidate_value.value : undefined);
                          const chip = voteChip(vote);

                          // Backwards-Compat (falls nur bool vorhanden)
                          const vb = vote ? undefined : asBool(a.candidate_value);

                          const hasEvidence = typeof pageExact === "number" || !!span;
                          const label =
                              typeof pageExact === "number"
                                  ? `📄 Seite ${pageExact}`
                                  : span
                                      ? (span.start === span.end ? `📄 Seite ${span.start}` : `📄 Seiten ${span.start}–${span.end}`)
                                      : "—";
                          const pageToOpen = typeof pageExact === "number" ? pageExact : span?.start;

                          return (
                              <TableRow key={a.id ?? i} hover>
                                <TableCell>{attemptNo}</TableCell>
                                <TableCell>
                                  <PromptName name={a.candidate_key ?? "—"} />
                                </TableCell>
                                <TableCell>
                                  {vote ? chip : (typeof vb === "boolean" ? (vb ? "✅ Ja" : "❌ Nein") : "—")}
                                </TableCell>
                                <TableCell>
                                  {hasEvidence
                                      ? <Chip size="small" variant="outlined" label={label}
                                              onClick={() => pageToOpen != null && onOpenEvidence(pageToOpen)} clickable/>
                                      : "—"}
                                </TableCell>
                                <TableCell>{a.is_final ? "⭐" : "—"}</TableCell>
                              </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </Box>
              );
            })}
          </Stack>
        </CardContent>
      </Card>
  );
}

function DetailedResultFindingCard({detail, onOpenEvidence}: {
  detail: RunDetail;
  onOpenEvidence: (page?: number) => void
}) {
  const extractionSteps = (detail.steps ?? []).filter(s => s.step_type === "Extraction");
  const scoreSteps = (detail.steps ?? []).filter(s => s.step_type === "Score");
  const decisionSteps = (detail.steps ?? []).filter(s => s.step_type === "Decision");

  if (!extractionSteps.length && !scoreSteps.length && !decisionSteps.length) return null;

  return (
      <Card variant="outlined">
        <CardHeader
            title="Ergebnisfindung je Prompt"
            subheader="Alle Kandidaten & Auswahl für Extraktions-, Bewertungs- und Entscheidungs-Prompts"
        />
        <CardContent>
          <Stack spacing={3}>
            {extractionSteps.length > 0 && (
                <Box>
                  <Typography
                      variant="subtitle1"
                      sx={{display: "flex", alignItems: "center", gap: 1, mb: 1}}
                  >
                    <ArticleIcon sx={{color: "primary.main"}} fontSize="small" />
                    Extraktion
                  </Typography>
                  <Stack spacing={2}>
                    {extractionSteps.map((s, idx) => (
                        <Box key={s.id}>
                          <Stack direction="row" alignItems="center" gap={1} sx={{mb: 0.5}}>
                            <PromptName name={s.final_key ?? s.definition?.json_key ?? `Extraktion ${idx + 1}`} />
                            <Typography component="span" variant="body2">
                              · Ergebnis: {formatValue(s.final_value)}
                            </Typography>
                            <Box sx={{flex: 1}} />
                            <ConfidenceBar value={s.final_confidence} />
                          </Stack>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell width={56}>#</TableCell>
                                <TableCell>Antwort</TableCell>
                                <TableCell width={160}>Konfidenz</TableCell>
                                <TableCell width={160}>Evidenz</TableCell>
                                <TableCell width={90}>Final</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {(s.attempts ?? []).map((a, i) => {
                                const meta = attemptEvidenceMeta(detail, s, a, i);
                                const confidence = extractAttemptConfidence(a);
                                return (
                                    <TableRow key={a.id ?? i} hover>
                                      <TableCell>{meta.attemptNo}</TableCell>
                                      <TableCell>{formatValue(a.candidate_value)}</TableCell>
                                      <TableCell>
                                        <ConfidenceBar value={confidence} />
                                      </TableCell>
                                      <TableCell>
                                        {meta.hasEvidence
                                            ? <Chip size="small" variant="outlined" label={meta.label}
                                                    onClick={() => meta.pageToOpen != null && onOpenEvidence(meta.pageToOpen)} clickable/>
                                            : "—"}
                                      </TableCell>
                                      <TableCell>{a.is_final ? "⭐" : "—"}</TableCell>
                                    </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </Box>
                    ))}
                  </Stack>
                </Box>
            )}

            {scoreSteps.length > 0 && (
                <Box>
                  <Typography
                      variant="subtitle1"
                      sx={{display: "flex", alignItems: "center", gap: 1, mb: 1}}
                  >
                    <RuleIcon sx={{color: "success.main"}} fontSize="small" />
                    Bewertung
                  </Typography>
                  <Stack spacing={2}>
                    {scoreSteps.map((s, idx) => {
                      const lbl = s.final_score_label as TernaryLabel | undefined;
                      return (
                          <Box key={s.id}>
                            <Stack direction="row" alignItems="center" gap={1} sx={{mb: 0.5}}>
                              <PromptName name={s.final_key ?? `Regel ${idx + 1}`} />
                              <Typography component="span" variant="body2" sx={{display: "flex", alignItems: "center", gap: .5}}>
                                · Ergebnis: {lbl ? voteChip(lbl) : (typeof s.final_value === "boolean" ? (s.final_value ? "✅ Ja" : "❌ Nein") : "—")}
                              </Typography>
                              <Box sx={{flex: 1}} />
                              <ConfidenceBar value={s.final_confidence} />
                            </Stack>
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell width={56}>#</TableCell>
                                  <TableCell>Erklärung</TableCell>
                                  <TableCell width={120}>Stimme</TableCell>
                                  <TableCell width={160}>Evidenz</TableCell>
                                  <TableCell width={90}>Final</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {(s.attempts ?? []).map((a, i) => {
                                  const meta = attemptEvidenceMeta(detail, s, a, i);
                                  const vote: TernaryLabel | undefined = a?.vote
                                      ?? (typeof a?.candidate_value?.value === "string" ? a.candidate_value.value : undefined);
                                  const chip = voteChip(vote);
                                  const vb = vote ? undefined : asBool(a.candidate_value);
                                  return (
                                      <TableRow key={a.id ?? i} hover>
                                        <TableCell>{meta.attemptNo}</TableCell>
                                        <TableCell>
                                          <PromptName name={a.candidate_key ?? "—"} />
                                        </TableCell>
                                        <TableCell>
                                          {vote ? chip : (typeof vb === "boolean" ? (vb ? "✅ Ja" : "❌ Nein") : "—")}
                                        </TableCell>
                                        <TableCell>
                                          {meta.hasEvidence
                                              ? <Chip size="small" variant="outlined" label={meta.label}
                                                      onClick={() => meta.pageToOpen != null && onOpenEvidence(meta.pageToOpen)} clickable/>
                                              : "—"}
                                        </TableCell>
                                        <TableCell>{a.is_final ? "⭐" : "—"}</TableCell>
                                      </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          </Box>
                      );
                    })}
                  </Stack>
                </Box>
            )}

            {decisionSteps.length > 0 && (
                <Box>
                  <Typography
                      variant="subtitle1"
                      sx={{display: "flex", alignItems: "center", gap: 1, mb: 1}}
                  >
                    <AltRouteIcon sx={{color: "warning.main"}} fontSize="small" />
                    Entscheidung
                  </Typography>
                  <Stack spacing={2}>
                    {decisionSteps.map((s, idx) => (
                        <Box key={s.id}>
                          <Stack direction="row" alignItems="center" gap={1} sx={{mb: 0.5}}>
                            <PromptName name={s.final_key ?? `Entscheidung ${idx + 1}`} />
                            <Typography component="span" variant="body2">
                              · Ergebnis: {typeof s.final_value === "boolean" ? (s.final_value ? "✅ Ja" : "❌ Nein") : formatValue(s.final_value)}
                            </Typography>
                            <Box sx={{flex: 1}} />
                            <ConfidenceBar value={s.final_confidence} />
                          </Stack>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell width={56}>#</TableCell>
                                <TableCell>Antwort</TableCell>
                                <TableCell width={160}>Evidenz</TableCell>
                                <TableCell width={90}>Final</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {(s.attempts ?? []).map((a, i) => {
                                const meta = attemptEvidenceMeta(detail, s, a, i);
                                const v = asBool(a.candidate_value);
                                return (
                                    <TableRow key={a.id ?? i} hover>
                                      <TableCell>{meta.attemptNo}</TableCell>
                                      <TableCell>{typeof v === "boolean" ? (v ? "✅ Ja" : "❌ Nein") : formatValue(a.candidate_value)}</TableCell>
                                      <TableCell>
                                        {meta.hasEvidence
                                            ? <Chip size="small" variant="outlined" label={meta.label}
                                                    onClick={() => meta.pageToOpen != null && onOpenEvidence(meta.pageToOpen)} clickable/>
                                            : "—"}
                                      </TableCell>
                                      <TableCell>{a.is_final ? "⭐" : "—"}</TableCell>
                                    </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </Box>
                    ))}
                  </Stack>
                </Box>
            )}
          </Stack>
        </CardContent>
      </Card>
  );
}

function DecisionVotesCard({detail, onOpenEvidence}: {
  detail: RunDetail;
  onOpenEvidence: (page?: number) => void
}) {
  const decisionSteps = (detail.steps ?? []).filter(s => s.step_type === "Decision");
  if (!decisionSteps.length) return null;

  return (
      <Card variant="outlined">
        <CardHeader title="Entscheidungs-Ergebnisse" subheader="Kandidaten (Mehrheit)"/>
        <CardContent>
          <Stack spacing={2}>
            {decisionSteps.map((s, idx) => (
                <Box key={s.id}>
                  <Stack direction="row" alignItems="center" gap={1} sx={{mb: 0.5}}>
                    <AltRouteIcon sx={{color: (s.final_value ? "success.main" : "error.main")}} fontSize="small"/>
                    <Typography variant="subtitle2" sx={{display: "flex", alignItems: "center", gap: .5}}>
                      <PromptName name={s.final_key ?? `Entscheidung ${idx + 1}`} /> · Ergebnis: {s.final_value ? "✅ Ja" : "❌ Nein"}
                    </Typography>
                    <Box sx={{flex: 1}}/>
                    <ConfidenceBar value={s.final_confidence}/>
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell width={56}>#</TableCell>
                        <TableCell>Kandidatentext</TableCell>
                        <TableCell width={120}>Stimme</TableCell>
                        <TableCell width={160}>Evidenz</TableCell>
                        <TableCell width={90}>Final</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(s.attempts ?? []).map((a, i) => {
                        const v = asBool(a.candidate_value);
                        const exact = getAttemptPage(a);
                        const attemptNo = (a?.attempt_no ?? i + 1) as number;
                        const span = exact == null ? batchPageSpanForAttempt(detail, s, attemptNo) : undefined;
                        const label =
                            typeof exact === "number"
                                ? `📄 Seite ${exact}`
                                : span
                                    ? (span.start === span.end ? `📄 Seite ${span.start}` : `📄 Seiten ${span.start}–${span.end}`)
                                    : "—";
                        const pageToOpen = typeof exact === "number" ? exact : span?.start;

                        return (
                            <TableRow key={a.id ?? i} hover>
                              <TableCell>{attemptNo}</TableCell>
                              <TableCell>{a.candidate_key ?? "—"}</TableCell>
                              <TableCell>{v ? "✅ Ja" : "❌ Nein"}</TableCell>
                              <TableCell>
                                {pageToOpen != null
                                    ? <Chip size="small" variant="outlined" label={label}
                                            onClick={() => onOpenEvidence(pageToOpen)} clickable/>
                                    : "—"}
                              </TableCell>
                              <TableCell>{a.is_final ? "⭐" : "—"}</TableCell>
                            </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Box>
            ))}
          </Stack>
        </CardContent>
      </Card>
  );
}

/* ===== Schritte (kompakte Übersicht) ===== */

function StepsOverview({ detail }: { detail: RunDetail }) {
  const steps = (detail.steps ?? []).slice().sort((a, b) => {
    const ao = (a.order_index ?? 0) - (b.order_index ?? 0);
    return ao !== 0 ? ao : (a.id - b.id);
  });

  if (!steps.length) {
    return (
        <Alert severity="info">
          Keine Schritt-Instanzen vorhanden. Läuft der Run noch oder liefert der
          Backend-Detail-Endpoint die Schritte nicht?
        </Alert>
    );
  }

  const tMap: Record<RunStep["step_type"], string> = {
    Extraction: "Extraktion",
    Decision: "Entscheidung",
    Score: "Bewertung"
  };

  return (
      <Card variant="outlined">
        <CardHeader title="Schritte & Versuche" subheader="Kompakte Pipeline-Übersicht: Typ, Prompt, Value"/>
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={160}>Typ</TableCell>
                <TableCell>Prompt</TableCell>
                <TableCell>Value</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {steps.map((s, idx) => {
                const typeLabel = tMap[s.step_type] ?? s.step_type;
                const name = s.definition?.json_key || s.final_key || `${s.step_type} ${idx + 1}`;

                let value: React.ReactNode = "—";
                if (s.step_type === "Score") {
                  value = s.final_score_label
                      ? voteChip(s.final_score_label)
                      : typeof s.final_value === "boolean"
                          ? (s.final_value ? "✅ Ja" : "❌ Nein")
                          : formatValue(s.final_value);
                } else if (s.step_type === "Decision") {
                  value = typeof s.final_value === "boolean" ? (s.final_value ? "✅ Ja" : "❌ Nein") : formatValue(s.final_value);
                } else {
                  value = formatValue(s.final_value);
                }

                return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Stack direction="row" alignItems="center" gap={1}>
                          <StepTypeIcon t={s.step_type}/>
                          <Typography variant="body2">{typeLabel}</Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <PromptName name={name} maxWidth={420}/>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{value}</Typography>
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

/* ===== Diverses ===== */

function Row({label, children}: { label: string; children: React.ReactNode }) {
  return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" sx={{minWidth: 150, color: "text.secondary"}}>{label}</Typography>
        <Box sx={{flex: 1}}>{children}</Box>
      </Stack>
  );
}
