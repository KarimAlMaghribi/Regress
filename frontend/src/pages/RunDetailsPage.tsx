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
  Divider,
  Grid,
  IconButton,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
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
import AssessmentIcon from "@mui/icons-material/Assessment"; // Scoring header
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";

import {type RunDetail, type RunStep, useRunDetails} from "../hooks/useRunDetails";

/** --------- helpers --------- */
const clamp01 = (n?: number | null) => Math.max(0, Math.min(1, Number.isFinite(n as number) ? (n as number) : 0));
const fmtNum = (n: number) => Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(n);
const asBool = (v: unknown) => (typeof v === "boolean" ? v : (typeof v === "object" && v !== null ? (v as any).bool ?? (v as any).decision : undefined));

function StatusChip({status}: { status?: string }) {
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
  return <InfoOutlinedIcon color="disabled" fontSize="small"/>;
}

function ConfidenceBar({value}: { value?: number | null }) {
  if (value == null || Number.isNaN(value)) return <Typography variant="body2">—</Typography>;
  const v = clamp01(value);
  return (
      <Stack direction="row" alignItems="center" gap={1} sx={{minWidth: 160}}>
        <Box sx={{flex: 1}}>
          <LinearProgress variant="determinate" value={v * 100}/>
        </Box>
        <Typography variant="caption" sx={{width: 36, textAlign: "right"}}>
          {(v * 100).toFixed(0)}%
        </Typography>
      </Stack>
  );
}

function formatValue(val: any) {
  if (val == null) return "—";
  if (typeof val === "boolean") return val ? "Ja" : "Nein";
  if (typeof val === "number") return fmtNum(val);
  if (typeof val === "string") return val;
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

function EvidenceChip({page, pdfUrl}: { page?: number; pdfUrl?: string }) {
  if (!page) return <>—</>;
  const open = () => pdfUrl && window.open(`${pdfUrl}#page=${page}`, "_blank", "noopener,noreferrer");
  return <Chip size="small" variant="outlined" label={`Seite ${page}`} onClick={open}/>;
}

/** --------- main page --------- */
export default function RunDetailsPage() {
  const params = useParams<{ id?: string; key?: string }>();
  const [sp] = useSearchParams();

  const key = params.key || params.id || undefined;
  const runId = sp.get("run_id") || sp.get("id") || undefined;
  const pdfUrl = sp.get("pdf") || sp.get("pdf_url") || undefined;

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
    } catch { /* ignore */ }
    return undefined;
  })();

  const { data, loading, error, scoreSum } =
      useRunDetails(runId, { pdfId, storageKey: key ? `run-view:${key}` : undefined });


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
        <HeaderBar detail={data} pdfUrl={pdfUrl}/>
        <Grid container spacing={2}>
          <Grid item xs={12} md={4}>
            <SummaryCard detail={data} scoreSum={scoreSum}/>
            <ScoreBreakdownCard detail={data}/>
            <DecisionCard detail={data}/>
          </Grid>

          <Grid item xs={12} md={8}>
            <ExtractionCard detail={data}/>
            <StepsWithAttempts detail={data} pdfUrl={pdfUrl}/>
          </Grid>
        </Grid>
      </Container>
  );
}

/** --------- sections --------- */

function HeaderBar({detail, pdfUrl}: { detail: RunDetail; pdfUrl?: string }) {
  const {run} = detail;
  return (
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{mb: 2}}>
        <Box>
          <Typography variant="h5">Analyse · Run</Typography>
          <Typography variant="body2" color="text.secondary">
            Pipeline: {run.pipeline_id} • PDF-ID: {run.pdf_id} • Status: <StatusChip
              status={run.status}/>
          </Typography>
        </Box>
        <Stack direction="row" gap={1}>
          {pdfUrl && (
              <Tooltip title="PDF öffnen">
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
      <Card variant="outlined" sx={{mb: 2}}>
        <CardHeader title="Übersicht" subheader="Konsolidierte Ergebnisse & Score"/>
        <CardContent>
          <Stack spacing={1.25}>
            <Stack direction="row" alignItems="center" gap={1}>
              <AssessmentIcon sx={{color: "success.main"}} fontSize="small"/>
              <Typography variant="body2" sx={{minWidth: 130, color: "text.secondary"}}>Final
                Score</Typography>
              <Box sx={{flex: 1}}>
                {typeof run.overall_score === "number" ? (
                    <Stack direction="row" alignItems="center" gap={1}>
                      <LinearProgress variant="determinate"
                                      value={clamp01(run.overall_score) * 100}/>
                      <Typography variant="caption" sx={{
                        width: 40,
                        textAlign: "right"
                      }}>{fmtNum(run.overall_score)}</Typography>
                    </Stack>
                ) : (
                    <Typography variant="body2">—</Typography>
                )}
              </Box>
            </Stack>

            <Row label="Extrakte">{finalKeys.length} Felder</Row>
            <Row label="Entscheidungen">{decKeys.length} Einträge</Row>
            <Row label="Score-Regeln">{scKeys.length} Regeln • Summe: {fmtNum(scoreSum)}</Row>
            <Divider sx={{my: 1}}/>
            <Row label="Start">{run.started_at ?? "—"}</Row>
            <Row label="Ende">{run.finished_at ?? "—"}</Row>
            {run.error && (
                <Row label="Fehler">
                  <Chip size="small" color="error" icon={<ErrorOutlineIcon/>} label={run.error}/>
                </Row>
            )}
          </Stack>
        </CardContent>
      </Card>
  );
}

function ScoreBreakdownCard({detail}: { detail: RunDetail }) {
  const map = detail.run.final_scores ?? {};
  const entries = useMemo(() => Object.entries(map), [map]);
  if (!entries.length) return null;

  return (
      <Card variant="outlined" sx={{mb: 2}}>
        <CardHeader title="Scoring (Beitrag je Regel)"
                    subheader="Gewicht addiert bei finalem TRUE"/>
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Regel</TableCell>
                <TableCell width={120} align="right">Beitrag</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell><Chip size="small" color={(v as number) > 0 ? "success" : "default"}
                                     label={k}/></TableCell>
                    <TableCell align="right">{fmtNum(typeof v === "number" ? v : 0)}</TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

function DecisionCard({detail}: { detail: RunDetail }) {
  const map = detail.run.final_decisions ?? {};
  const entries = useMemo(() => Object.entries(map), [map]);
  if (!entries.length) return null;

  return (
      <Card variant="outlined" sx={{mb: 2}}>
        <CardHeader title="Finale Entscheidungen" subheader="Routen/Ja-Nein"/>
        <CardContent>
          <Stack direction="row" gap={1} flexWrap="wrap">
            {entries.map(([k, b]) => (
                <Chip
                    key={k}
                    size="small"
                    color={b ? "success" : "error"}
                    icon={b ? <CheckCircleOutlineIcon/> : <ErrorOutlineIcon/>}
                    label={`${k}: ${b ? "Ja" : "Nein"}`}
                    variant={b ? "filled" : "outlined"}
                />
            ))}
          </Stack>
        </CardContent>
      </Card>
  );
}

function ExtractionCard({detail}: { detail: RunDetail }) {
  const map = detail.run.final_extraction ?? {};
  const entries = useMemo(() => Object.entries(map), [map]);
  if (!entries.length) return null;

  return (
      <Card variant="outlined" sx={{mb: 2}}>
        <CardHeader title="Finale Extraktion" subheader="Konsolidierte Felder"/>
        <CardContent>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Feld</TableCell>
                <TableCell>Wert</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell><Chip size="small" label={k}/></TableCell>
                    <TableCell>{formatValue(v)}</TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}

function StepsWithAttempts({detail, pdfUrl}: { detail: RunDetail; pdfUrl?: string }) {
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
        <CardHeader title="Steps & Attempts" subheader="Normalisierung je Step (Top-1 → final)"/>
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

                  {/* Attempts */}
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell width={56}>#</TableCell>
                        <TableCell>Candidate Key</TableCell>
                        <TableCell>Value</TableCell>
                        <TableCell width={180}>Confidence</TableCell>
                        <TableCell width={120}>Quelle</TableCell>
                        <TableCell width={100}>Evidenz</TableCell>
                        <TableCell width={90}>Final</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(s as any).attempts?.map((a: any, i: number) => {
                        const page =
                            a?.candidate_value?.page ??
                            a?.candidate_value?.source?.page ??
                            a?.candidate_value?.page_no;
                        const bool = asBool(a?.candidate_value);
                        return (
                            <TableRow key={a.id ?? i} hover>
                              <TableCell>{a.attempt_no ?? i + 1}</TableCell>
                              <TableCell>{a.candidate_key ?? "—"}</TableCell>
                              <TableCell>
                                <Typography variant="body2">
                                  {typeof bool === "boolean" ? (bool ? "Ja" : "Nein") : formatValue(a.candidate_value)}
                                </Typography>
                              </TableCell>
                              <TableCell><ConfidenceBar value={a.candidate_confidence}/></TableCell>
                              <TableCell>{a.source ?? "—"}</TableCell>
                              <TableCell><EvidenceChip page={page} pdfUrl={pdfUrl}/></TableCell>
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

/** --------- small UI bits --------- */

function Row({label, children}: { label: string; children: React.ReactNode }) {
  return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2"
                    sx={{minWidth: 130, color: "text.secondary"}}>{label}</Typography>
        <Box sx={{flex: 1}}>{children}</Box>
      </Stack>
  );
}

function labelForStep(s: RunStep) {
  const name = s.definition?.json_key || s.final_key || `${s.step_type}`;
  return `${name} · ${s.step_type}`;
}
