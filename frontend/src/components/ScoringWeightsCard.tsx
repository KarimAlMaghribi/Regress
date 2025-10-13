// === ScoringWeightsCard.tsx (dedupliziert) ===============================
// Benötigt: @mui/material
import * as React from "react";
import {
  Box,
  Card,
  CardHeader,
  CardContent,
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

import {type RunDetail, type RunStep, type TernaryLabel} from "../hooks/useRunDetails";

function coerceLabel(value: any): TernaryLabel | undefined {
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

function isPositiveLabel(label?: TernaryLabel | null): boolean {
  return label === "yes";
}

function resolveLabel(detail: RunDetail, step: RunStep, slug: string): TernaryLabel | undefined {
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

export function scoreColor(score: number): string {
  if (score >= 0.75) return "success.main";
  if (score >= 0.5) return "warning.main";
  return "error.main";
}

function prettyPromptLabel(raw?: string | null) {
  if (!raw) return "—";
  return raw.replace(/_/g, " ").trim();
}

function PromptLabel({label}: {label?: string | null}) {
  const pretty = prettyPromptLabel(label);
  return (
      <Tooltip title={pretty} placement="top-start">
        <Box sx={{maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
          {pretty}
        </Box>
      </Tooltip>
  );
}

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
    const prettyName = slug ?? "";
    return {
      slug: slug ?? "undefined",
      prettyName,
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
  const scorePct = computedScore * 100;

  const segments = rows
  .sort((a, b) => a.slug.localeCompare(b.slug))
  .map((r) => ({
    key: r.slug,
    widthPct: totalWeight > 0 ? (r.weight / totalWeight) * 100 : 0,
    color: r.positive ? POS : NEG,
    label: prettyPromptLabel(r.prettyName),
    tooltip: `${prettyPromptLabel(r.prettyName)} • Gewicht ${r.weight.toFixed(2)} • ${r.positive ? "in Score" : "ignoriert"}`,
  }));

  return (
      <Card variant="outlined">
        <CardHeader
            title="Scoring-Ergebnisse"
            subheader={
              <Typography variant="subtitle2" sx={{color: scoreColor(computedScore), fontWeight: 600}}>
                Gesamt-Score: {scorePct.toFixed(0)}%
              </Typography>
            }
        />
        <CardContent>
          {/* Zusammenfassung */}
          <Stack spacing={1.25} sx={{ mb: 2 }}>
            <Stack direction="row" alignItems="center" gap={2}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Endscore
              </Typography>
              <Box sx={{ flex: 1 }}>
                <LinearProgress
                    variant="determinate"
                    value={computedScore * 100}
                    sx={{ '& .MuiLinearProgress-bar': { bgcolor: scoreColor(computedScore) } }}
                />
              </Box>
              <Typography variant="body2" sx={{ width: 56, textAlign: "right", color: scoreColor(computedScore), fontWeight: 600 }}>
                {scorePct.toFixed(0)}%
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
                Aktive Weights (true): {positiveSum.toFixed(2)}
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
                      <PromptLabel label={r.prettyName} />
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
