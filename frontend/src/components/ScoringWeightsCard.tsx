// === ScoringWeightsCard.tsx (dedupliziert) ===============================
// Benötigt: @mui/material
import * as React from "react";
import {
  Box,
  Card,
  CardHeader,
  CardContent,
  Chip,
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

// ==== Types (an deine vorhandenen Typen angelehnt) ====
type StepType = "Extraction" | "Decision" | "Score";
interface Attempt {
  is_final?: boolean;
  candidate_value?: any;
}
interface RunStep {
  step_type: StepType;
  final_key?: string | null;
  final_value?: any;
  final_confidence?: number | null;
  final_score_label?: "yes" | "no" | "unsure" | null;
  definition?: { json_key?: string } | null;
  attempts?: Attempt[];
}
interface RunCore {
  final_scores?: Record<string, number>;         // Weights
  final_decisions?: Record<string, boolean>;     // Ergebnisse true/false (legacy)
  final_score_labels?: Record<string, "yes" | "no" | "unsure">; // konsolidierte Labels (optional)
  overall_score?: number | null;
}
export interface RunDetail {
  run: RunCore;
  steps: RunStep[];
}

// === Hilfsfunktion: finalen bool-Wert & Confidence je Slug ermitteln
function pickFinalForSlug(detail: RunDetail, slug: string) {
  const step =
      detail.steps.find(
          (s) =>
              s.step_type === "Score" &&
              (s.final_key === slug || s.definition?.json_key === slug)
      ) ?? null;

  const result =
      detail.run.final_decisions && slug in detail.run.final_decisions
          ? !!detail.run.final_decisions[slug]
          : !!step?.final_value;

  const conf = step?.final_confidence ?? null;

  return { result, conf };
}

function coerceLabel(value: any): "yes" | "no" | "unsure" | undefined {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "yes" || lower === "no" || lower === "unsure") return lower;
    if (lower === "true") return "yes";
    if (lower === "false") return "no";
  }
  return undefined;
}

function isPositiveLabel(label?: "yes" | "no" | "unsure" | null): boolean {
  return label === "yes";
}

function resolveLabel(detail: RunDetail, step: RunStep, slug: string): "yes" | "no" | "unsure" | undefined {
  const fromStep = step.final_score_label ?? coerceLabel(step.final_value);
  if (fromStep) return fromStep;
  const fromRun = detail.run.final_score_labels?.[slug];
  if (fromRun) return fromRun;
  const legacyDecision = detail.run.final_decisions?.[slug];
  if (typeof legacyDecision === "boolean") return legacyDecision ? "yes" : "no";
  return undefined;
}

// === Berechnung gewichteter Score
export function computeWeightedScore(detail: RunDetail): number {
  const scoringSteps = detail.steps.filter((s) => s.step_type === "Score");
  if (!scoringSteps.length) {
    return typeof detail.run.overall_score === "number" ? detail.run.overall_score : 0;
  }

  let total = 0;
  let positive = 0;

  for (const step of scoringSteps) {
    const slug = step.final_key || step.definition?.json_key;
    if (!slug) continue;
    const weightRaw = detail.run.final_scores?.[slug];
    const weight = typeof weightRaw === "number" && Number.isFinite(weightRaw) ? weightRaw : 0;
    if (weight <= 0) continue;
    total += weight;
    const label = resolveLabel(detail, step, slug);
    if (isPositiveLabel(label)) positive += weight;
  }

  if (total <= 0) return 0;
  return positive / total;
}

// === UI-Helfer: Farben
const POS = "#28a745"; // grün
const NEG = "#9aa0a6"; // grau

export function ScoringWeightsCard({ detail }: { detail: RunDetail }) {
  const weights = detail.run.final_scores ?? {};

  const rows = detail.steps
  .filter((s) => s.step_type === "Score")
  .map((s) => {
    const slug = s.final_key || s.definition?.json_key;
    const weightRaw = slug ? weights[slug] : undefined;
    const weight = typeof weightRaw === "number" && Number.isFinite(weightRaw) ? weightRaw : 0;
    const label = slug ? resolveLabel(detail, s, slug) : undefined;
    const positive = isPositiveLabel(label);
    const conf = s.final_confidence ?? null;
    return {
      slug: slug ?? "undefined",
      weight,
      label,
      positive,
      conf,
      contribution: positive ? weight : 0,
    };
  })
  .filter((r, i, all) => r.slug !== "undefined" && all.findIndex(x => x.slug === r.slug) === i);

  if (!rows.length) return null;

  const totalWeight = rows.reduce((a, r) => a + r.weight, 0);
  const positiveSum = rows.reduce((a, r) => a + r.contribution, 0);
  const computedScore = totalWeight > 0 ? positiveSum / totalWeight : 0;

  const segments = rows
  .sort((a, b) => a.slug.localeCompare(b.slug))
  .map((r) => ({
    key: r.slug,
    widthPct: totalWeight > 0 ? (r.weight / totalWeight) * 100 : 0,
    color: r.positive ? POS : NEG,
    label: r.slug,
    tooltip: `${r.slug} • Weight ${r.weight.toFixed(2)} • ${r.positive ? "zählt" : "zählt nicht"}`,
  }));

  return (
      <Card variant="outlined">
        <CardHeader
            title="Scoring-Ergebnisse"
            subheader="Gewichtete Regeln und Beitrag zum Endscore"
        />
        <CardContent>
          {/* Zusammenfassung */}
          <Stack spacing={1.25} sx={{ mb: 2 }}>
            <Stack direction="row" alignItems="center" gap={2}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Endscore
              </Typography>
              <Box sx={{ flex: 1 }}>
                <LinearProgress variant="determinate" value={computedScore * 100} />
              </Box>
              <Typography variant="body2" sx={{ width: 56, textAlign: "right" }}>
                {(computedScore * 100).toFixed(0)}%
              </Typography>
            </Stack>

            {/* Gestapelter Balken der Weights */}
            <Box
                sx={{
                  mt: 0.5,
                  borderRadius: 1,
                  overflow: "hidden",
                  border: "1px solid",
                  borderColor: "divider",
                  height: 16,
                  display: "flex",
                }}
                aria-label="Gewichtete Regel-Segmente"
            >
              {segments.map((seg) => (
                  <Tooltip key={seg.key} title={seg.tooltip} placement="top">
                    <Box
                        sx={{
                          width: `${seg.widthPct}%`,
                          bgcolor: seg.color,
                          height: "100%",
                          transition: "width 0.2s",
                        }}
                    />
                  </Tooltip>
              ))}
            </Box>

            <Stack direction="row" spacing={2}>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                ∑ Weights: {totalWeight.toFixed(2)}
              </Typography>
              <Typography variant="caption" sx={{ color: POS }}>
                Positive Contribution: {positiveSum.toFixed(2)}
              </Typography>
            </Stack>
          </Stack>

          {/* Detailtabelle pro Regel */}
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Regel</TableCell>
                <TableCell align="right">Weight</TableCell>
                <TableCell align="center">Ergebnis</TableCell>
                <TableCell align="center">Contribution</TableCell>
                <TableCell align="center">Confidence</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows
              .sort((a, b) => a.slug.localeCompare(b.slug))
              .map((r) => (
                  <TableRow key={r.slug} hover>
                    <TableCell>
                      <Chip size="small" label={r.slug} />
                    </TableCell>
                    <TableCell align="right">{r.weight.toFixed(2)}</TableCell>
                    <TableCell align="center">
                      {r.label === "yes" ? "✅ Ja" : r.label === "no" ? "❌ Nein" : r.label === "unsure" ? "⚪ Unsicher" : "—"}
                    </TableCell>
                    <TableCell align="center" sx={{ color: r.positive ? POS : "text.disabled" }}>
                      {r.contribution.toFixed(2)}
                    </TableCell>
                    <TableCell align="center">
                      {r.conf == null ? "—" : `${Math.round(Math.max(0, Math.min(1, r.conf)) * 100)}%`}
                    </TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
  );
}
