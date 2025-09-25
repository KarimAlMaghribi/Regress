// src/pages/RunDetailsPage.tsx
import * as React from "react";
import {useMemo} from "react";
import {useParams, useSearchParams} from "react-router-dom";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ArticleIcon from "@mui/icons-material/Article"; // Extraction
import RuleIcon from "@mui/icons-material/Rule"; // Score
import AltRouteIcon from "@mui/icons-material/AltRoute"; // Decision
import AssessmentIcon from "@mui/icons-material/Assessment"; // Summary
import CloseIcon from "@mui/icons-material/Close";

import {type RunDetail, type RunStep, useRunDetails} from "../hooks/useRunDetails";

/* ===== helpers ===== */
const clamp01 = (n?: number | null) => Math.max(0, Math.min(1, Number.isFinite(n as number) ? (n as number) : 0));
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

function resolvePdfUrl(raw?: string | null, pdfId?: number | null): string | undefined {
  const ipBase = "http://192.168.130.102:8081";
  if (raw && typeof raw === "string") {
    // normalize host "pdf-ingest" → IP
    return raw.replace("http://pdf-ingest:8081", ipBase);
  }
  if (pdfId != null) return `${ipBase}/pdf/${pdfId}`;
  return undefined;
}

/* ===== small UI bits ===== */

function StatusChip({status}: { status?: string | null }) {
  const map: Record<string, {
    color: "default" | "success" | "error" | "warning" | "info";
    icon: React.ReactNode;
    label: string
  }> = {
    queued: {color: "info", icon: <HourglassEmptyIcon fontSize="small"/>, label: "Wartend"},
    running: {color: "warning", icon: <PlayArrowIcon fontSize="small"/>, label: "Laufend"},
    finalized: {color: "success", icon: <CheckCircleOutlineIcon fontSize="small"/>, label: "Final"},
    completed: {
      color: "success",
      icon: <CheckCircleOutlineIcon fontSize="small"/>,
      label: "Abgeschlossen"
    },
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

/* ===== Evidence Modal ===== */

function EvidenceModal({
                         open, onClose, page, pdfUrl, detail
                       }: {
  open: boolean;
  onClose: () => void;
  page?: number;
  pdfUrl?: string;
  detail: RunDetail
}) {

  const byPage = React.useMemo(() => {
    const items = {extraction: [] as any[], scoring: [] as any[], decision: [] as any[]};

    (detail.steps ?? []).forEach(s => {
      (s.attempts ?? []).forEach(a => {
        const p = getAttemptPage(a);
        if (!page || p === page) {
          const row = {step: s, attempt: a};
          if (s.step_type === "Extraction") items.extraction.push(row);
          else if (s.step_type === "Score") items.scoring.push(row);
          else if (s.step_type === "Decision") items.decision.push(row);
        }
      });
    });

    // kleine sortierung
    const byKey = (r: any) => r.step.final_key ?? r.step.definition?.json_key ?? "";
    items.extraction.sort((a, b) => byKey(a).localeCompare(byKey(b)));
    items.scoring.sort((a, b) => byKey(a).localeCompare(byKey(b)));
    items.decision.sort((a, b) => byKey(a).localeCompare(byKey(b)));
    return items;
  }, [detail, page]);

  return (
      <Dialog open={open} onClose={onClose} maxWidth="xl" fullWidth>
        // im EvidenceModal-Header:
        <DialogTitle sx={{display: "flex", alignItems: "center", gap: 1}}>
          📄 Seite
          <IconButton size="small" onClick={() => onChangePage?.(Math.max(1, (page ?? 2) - 1))}
                      disabled={(page ?? 1) <= 1}>‹</IconButton>
          <input
              type="number"
              value={page ?? 1}
              onChange={e => onChangePage?.(Math.max(1, Number(e.target.value) || 1))}
              style={{width: 64}}
          />
          <IconButton size="small" onClick={() => onChangePage?.((page ?? 1) + 1)}>›</IconButton>
          <Box sx={{flex: 1}}/>
          <IconButton size="small" onClick={onClose}><CloseIcon/></IconButton>
        </DialogTitle>

        <DialogContent dividers sx={{p: 0}}>
          <Box sx={{display: "flex", height: "80vh"}}>
            {/* Left: PDF */}
            <Box sx={{
              flex: 1,
              minWidth: 0,
              borderRight: theme => `1px solid ${theme.palette.divider}`
            }}>
              {pdfUrl ? (
                  <iframe
                      title="PDF"
                      src={`${pdfUrl}#page=${page ?? 1}`}
                      style={{width: "100%", height: "100%", border: 0}}
                  />
              ) : (
                  <Stack sx={{height: "100%"}} alignItems="center" justifyContent="center">
                    <Typography variant="body2" color="text.secondary">Kein PDF
                      verfügbar</Typography>
                  </Stack>
              )}
            </Box>

            {/* Right: Results for this page */}
            <Box sx={{width: 480, p: 2, overflowY: "auto"}}>
              <Typography variant="subtitle1" sx={{mb: 1}}>Ergebnisse auf dieser Seite</Typography>

              {/* Extraction */}
              <Section title="🧩 Extraction">
                {byPage.extraction.length === 0 ? <EmptyLine/> :
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
                              <TableCell>{r.step.final_key ?? r.step.definition?.json_key ?? "—"}</TableCell>
                              <TableCell>{formatValue(r.attempt.candidate_value)}</TableCell>
                              <TableCell>{r.attempt.is_final ? "⭐" : "—"}</TableCell>
                            </TableRow>
                        ))}
                      </TableBody>
                    </Table>}
              </Section>

              {/* Scoring */}
              <Section title="🟢 Scoring">
                {byPage.scoring.length === 0 ? <EmptyLine/> :
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Regel</TableCell>
                          <TableCell>Vote</TableCell>
                          <TableCell width={60}>Final</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {byPage.scoring.map((r, i) => {
                          const v = asBool(r.attempt.candidate_value);
                          return (
                              <TableRow key={i} hover>
                                <TableCell>{r.step.final_key ?? r.step.definition?.json_key ?? "—"}</TableCell>
                                <TableCell>{v ? "✅ Ja" : "❌ Nein"}</TableCell>
                                <TableCell>{r.attempt.is_final ? "⭐" : "—"}</TableCell>
                              </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>}
              </Section>

              {/* Decision */}
              <Section title="⚖️ Decision">
                {byPage.decision.length === 0 ? <EmptyLine/> :
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Frage</TableCell>
                          <TableCell>Vote</TableCell>
                          <TableCell width={60}>Final</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {byPage.decision.map((r, i) => {
                          const v = asBool(r.attempt.candidate_value);
                          return (
                              <TableRow key={i} hover>
                                <TableCell>{r.step.final_key ?? r.step.definition?.json_key ?? "—"}</TableCell>
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

/* ===== Page ===== */

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
    } catch {
    }
    return undefined;
  })();

  const {data, loading, error, scoreSum} =
      useRunDetails(runId, {pdfId, storageKey: key ? `run-view:${key}` : undefined});

  // ► PDF-URL auf IP normalisieren
  const resolvedPdfUrl = resolvePdfUrl(rawPdf ?? undefined, data?.run?.pdf_id);

  // Modal State
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
          <ScoringVotesCard detail={data} onOpenEvidence={openEvidence}/>
          <DecisionVotesCard detail={data} onOpenEvidence={openEvidence}/>
          <StepsWithAttempts detail={data} pdfUrl={resolvedPdfUrl} onOpenEvidence={openEvidence}/>
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

/* ===== Header / Summary ===== */

function HeaderBar({detail, pdfUrl}: { detail: RunDetail; pdfUrl?: string }) {
  const {run} = detail;
  return (
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{mb: 1}}>
        <Box>
          <Typography variant="h5">Analyse · Run</Typography>
          <Typography variant="body2" color="text.secondary">
            Pipeline: {run.pipeline_id} • PDF-ID: {run.pdf_id} • Status: <StatusChip
              status={run.status}/>
          </Typography>
        </Box>
        <Stack direction="row" gap={1}>
          {pdfUrl && (
              <Tooltip title="PDF im neuen Tab öffnen">
                <IconButton size="small"
                            onClick={() => window.open(pdfUrl!, "_blank", "noopener,noreferrer")}>
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

function SummaryCard({detail, scoreSum}: { detail: RunDetail; scoreSum: number }) {
  const {run} = detail;
  const finalKeys = Object.keys(run.final_extraction ?? {});
  const decKeys = Object.keys(run.final_decisions ?? {});
  const scKeys = Object.keys(run.final_scores ?? {});

  return (
      <Card variant="outlined">
        <CardHeader title="Übersicht" subheader="Konsolidierte Ergebnisse & Score"/>
        <CardContent>
          <Stack spacing={1.25}>
            <Stack direction="row" alignItems="center" gap={1}>
              <AssessmentIcon sx={{color: "success.main"}} fontSize="small"/>
              <Typography variant="body2" sx={{minWidth: 150, color: "text.secondary"}}>Final
                Score</Typography>
              <Box sx={{flex: 1}}>
                {typeof run.overall_score === "number" ? (
                    <Stack direction="row" alignItems="center" gap={1}>
                      <LinearProgress variant="determinate"
                                      value={clamp01(run.overall_score) * 100}/>
                      <Typography variant="caption" sx={{width: 40, textAlign: "right"}}>
                        {fmtNum(run.overall_score)}
                      </Typography>
                    </Stack>
                ) : (
                    <Typography variant="body2">—</Typography>
                )}
              </Box>
            </Stack>

            <Row label="Extrakte">🧩 {finalKeys.length} Felder</Row>
            <Row label="Entscheidungen">⚖️ {decKeys.length} Einträge</Row>
            <Row label="Score-Regeln">🟢 {scKeys.length} Regeln • Summe: {fmtNum(scoreSum)}</Row>
            <Divider sx={{my: 1}}/>
            <Row label="Start">🕒 {detail.run.started_at ?? "—"}</Row>
            <Row label="Ende">🏁 {detail.run.finished_at ?? "—"}</Row>
            {detail.run.error && (
                <Row label="Fehler">
                  <Chip size="small" color="error" icon={<ErrorOutlineIcon/>}
                        label={detail.run.error}/>
                </Row>
            )}
          </Stack>
        </CardContent>
      </Card>
  );
}

/* ===== Cards ===== */

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
                <TableCell width={180} align="right">Confidence</TableCell>
                <TableCell width={130} align="right">Evidenz</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([k, v]) => {
                const page = (v && typeof v === "object" && "page" in (v as any)) ? (v as any).page : undefined;
                return (
                    <TableRow key={k}>
                      <TableCell><Chip size="small" label={k}/></TableCell>
                      <TableCell>{formatValue(v)}</TableCell>
                      <TableCell align="right"><ConfidenceBar value={confByKey.get(k)}/></TableCell>
                      <TableCell align="right">
                        {page
                            ? <Chip size="small" variant="outlined" label={`📄 Seite ${page}`}
                                    onClick={() => onOpenEvidence(page)} clickable/>
                            : <Chip size="small" variant="outlined" label="—"/>}
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

function ScoringVotesCard({detail, onOpenEvidence}: {
  detail: RunDetail;
  onOpenEvidence: (page?: number) => void
}) {
  const scoreSteps = (detail.steps ?? []).filter(s => s.step_type === "Score");
  if (!scoreSteps.length) return null;

  return (
      <Card variant="outlined">
        <CardHeader title="Scoring-Ergebnisse" subheader="Kandidaten (Mehrheit)"/>
        <CardContent>
          <Stack spacing={2}>
            {scoreSteps.map((s, idx) => (
                <Box key={s.id}>
                  <Stack direction="row" alignItems="center" gap={1} sx={{mb: 0.5}}>
                    <RuleIcon sx={{color: (s.final_value ? "success.main" : "error.main")}}
                              fontSize="small"/>
                    <Typography variant="subtitle2">
                      {s.final_key ?? `Score-Regel ${idx + 1}`} ·
                      Ergebnis: {s.final_value ? "✅ Ja" : "❌ Nein"}
                    </Typography>
                    <Box sx={{flex: 1}}/>
                    <ConfidenceBar value={s.final_confidence}/>
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell width={56}>#</TableCell>
                        <TableCell>Begründung</TableCell>
                        <TableCell width={120}>Vote</TableCell>
                        <TableCell width={120}>Evidenz</TableCell>
                        <TableCell width={90}>Final</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(s.attempts ?? []).map((a, i) => {
                        const v = asBool(a.candidate_value);
                        const page = getAttemptPage(a);
                        return (
                            <TableRow key={a.id ?? i} hover>
                              <TableCell>{a.attempt_no ?? i + 1}</TableCell>
                              <TableCell>{a.candidate_key ?? "—"}</TableCell>
                              <TableCell>{v ? "✅ Ja" : "❌ Nein"}</TableCell>
                              <TableCell>
                                {page
                                    ?
                                    <Chip size="small" variant="outlined" label={`📄 Seite ${page}`}
                                          onClick={() => onOpenEvidence(page)} clickable/>
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

function DecisionVotesCard({detail, onOpenEvidence}: {
  detail: RunDetail;
  onOpenEvidence: (page?: number) => void
}) {
  const decisionSteps = (detail.steps ?? []).filter(s => s.step_type === "Decision");
  if (!decisionSteps.length) return null;

  return (
      <Card variant="outlined">
        <CardHeader title="Decision-Ergebnisse" subheader="Kandidaten (Mehrheit)"/>
        <CardContent>
          <Stack spacing={2}>
            {decisionSteps.map((s, idx) => (
                <Box key={s.id}>
                  <Stack direction="row" alignItems="center" gap={1} sx={{mb: 0.5}}>
                    <AltRouteIcon sx={{color: (s.final_value ? "success.main" : "error.main")}}
                                  fontSize="small"/>
                    <Typography variant="subtitle2">
                      {s.final_key ?? `Decision ${idx + 1}`} ·
                      Ergebnis: {s.final_value ? "✅ Ja" : "❌ Nein"}
                    </Typography>
                    <Box sx={{flex: 1}}/>
                    <ConfidenceBar value={s.final_confidence}/>
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell width={56}>#</TableCell>
                        <TableCell>Quelle</TableCell>
                        <TableCell width={120}>Vote</TableCell>
                        <TableCell width={120}>Evidenz</TableCell>
                        <TableCell width={90}>Final</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(s.attempts ?? []).map((a, i) => {
                        const v = asBool(a.candidate_value);
                        const page = getAttemptPage(a);
                        return (
                            <TableRow key={a.id ?? i} hover>
                              <TableCell>{a.attempt_no ?? i + 1}</TableCell>
                              <TableCell>{a.candidate_key ?? "—"}</TableCell>
                              <TableCell>{v ? "✅ Ja" : "❌ Nein"}</TableCell>
                              <TableCell>
                                {page
                                    ?
                                    <Chip size="small" variant="outlined" label={`📄 Seite ${page}`}
                                          onClick={() => onOpenEvidence(page)} clickable/>
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

/* ===== Steps (Detail) ===== */

function StepsWithAttempts({
                             detail, pdfUrl, onOpenEvidence
                           }: {
  detail: RunDetail;
  pdfUrl?: string;
  onOpenEvidence: (page?: number) => void
}) {
  const steps = (detail.steps ?? []).slice().sort((a, b) => {
    const ao = (a.order_index ?? 0) - (b.order_index ?? 0);
    return ao !== 0 ? ao : (a.id - b.id);
  });

  if (!steps.length) {
    return (
        <Alert severity="info">
          Keine Step-Instanzen vorhanden. Läuft der Run noch oder liefert der
          Backend-Detail-Endpoint die Steps nicht?
        </Alert>
    );
  }

  return (
      <Card variant="outlined">
        <CardHeader title="Steps & Attempts" subheader="Audit-Trail je Step"/>
        <CardContent>
          {steps.map((s, idx) => (
              <Accordion key={s.id} defaultExpanded={idx === 0}>
                <AccordionSummary expandIcon={<ExpandMoreIcon/>}>
                  <Stack direction="row" alignItems="center" gap={1} sx={{width: "100%"}}>
                    <Typography variant="body2" sx={{minWidth: 28, color: "text.secondary"}}>
                      {(s.order_index ?? idx) + 1}.
                    </Typography>
                    <StepTypeIcon t={s.step_type}/>
                    <Typography sx={{flex: 1}}>
                      {labelForStep(s)}
                    </Typography>
                    <StatusChip status={s.status}/>
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={1} sx={{mb: 1}}>
                    <Row label="Final Key"><Chip size="small" label={s.final_key ?? "—"}/></Row>
                    <Row label="Final Value"><Typography
                        variant="body2">{formatValue(s.final_value)}</Typography></Row>
                    <Row label="Confidence"><ConfidenceBar value={s.final_confidence}/></Row>
                    <Row label="Zeit">
                      <Typography
                          variant="body2">{s.started_at ?? "—"} → {s.finished_at ?? "—"}</Typography>
                    </Row>
                  </Stack>

                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell width={56}>#</TableCell>
                        <TableCell>Candidate Key</TableCell>
                        <TableCell>Value</TableCell>
                        <TableCell width={120}>Quelle</TableCell>
                        <TableCell width={120}>Evidenz</TableCell>
                        <TableCell width={90}>Final</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(s as any).attempts?.map((a: any, i: number) => {
                        const page = getAttemptPage(a);
                        const display = formatValue(a?.candidate_value);
                        return (
                            <TableRow key={a.id ?? i} hover>
                              <TableCell>{a.attempt_no ?? i + 1}</TableCell>
                              <TableCell>{a.candidate_key ?? "—"}</TableCell>
                              <TableCell><Typography
                                  variant="body2">{display}</Typography></TableCell>
                              <TableCell>{a.source ?? "—"}</TableCell>
                              <TableCell>
                                {page
                                    ?
                                    <Chip size="small" variant="outlined" label={`📄 Seite ${page}`}
                                          onClick={() => onOpenEvidence(page)} clickable/>
                                    : "—"}
                              </TableCell>
                              <TableCell>
                                {a.is_final ? <Chip size="small" color="success" label="final"/> :
                                    <Chip size="small" variant="outlined" label="—"/>}
                              </TableCell>
                            </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
          ))}
        </CardContent>
      </Card>
  );
}

/* ===== misc ===== */

function Row({label, children}: { label: string; children: React.ReactNode }) {
  return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2"
                    sx={{minWidth: 150, color: "text.secondary"}}>{label}</Typography>
        <Box sx={{flex: 1}}>{children}</Box>
      </Stack>
  );
}

function labelForStep(s: RunStep) {
  const name = s.definition?.json_key || s.final_key || `${s.step_type}`;
  return `${name} · ${s.step_type}`;
}
