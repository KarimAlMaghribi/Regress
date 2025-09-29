// === ScoringWeightsCard.tsx (kopierfertig) ===============================
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
  definition?: { json_key?: string } | null;
  attempts?: Attempt[];
}
interface RunCore {
  final_scores?: Record<string, number>;         // Weights
  final_decisions?: Record<string, boolean>;     // Ergebnisse true/false (legacy)
  overall_score?: number | null;
}
export interface RunDetail {
  run: RunCore;
  steps: RunStep[];
}

// === Hilfsfunktion: finalen bool-Wert & Confidence je Scoring-Slug ermitteln
function pickFinalForSlug(detail: RunDetail, slug: string) {
  const step =
      detail.steps.find(
          (s) =>
              s.step_type === "Score" &&
              (s.final_key === slug || s.definition?.json_key === slug)
      ) ?? null;

  const result =
      detail.run.final_decisions && slug in (detail.run.final_decisions ?? {})
          ? !!detail.run.final_decisions![slug]
          : !!step?.final_value;

  const conf = step?.final_confidence ?? null;

  return { result, conf };
}

// === Export: berechne gewichteten Score aus Weights × finalen Ergebnissen
export function computeWeightedScore(detail: RunDetail): number {
  const weights = detail.run.final_scores ?? {};
  const entries = Object.entries(weights);
  if (!entries.length) {
    // Fallback auf Backendwert, wenn vorhanden
    return typeof detail.run.overall_score === "number" ? detail.run.overall_score : 0;
  }

  let total = 0;
  let positive = 0;
  for (const [slug, w] of entries) {
    const weight = Number(w) || 0;
    total += weight;
    const { result } = pickFinalForSlug(detail, slug);
    if (result) positive += weight;
  }
  if (total <= 0) return 0;
  return positive / total;
}

// === UI-Helfer: Farben
const POS = "#28a745"; // grün
const NEG = "#9aa0a6"; // grau

export function ScoringWeightsCard({ detail }: { detail: RunDetail }) {
  const weights = detail.run.final_scores ?? {};
  const rows = Object.entries(weights).map(([slug, w]) => {
    const weight = Number(w) || 0;
    const { result, conf } = pickFinalForSlug(detail, slug);
    const contribution = result ? weight : 0;
    return { slug, weight, result, contribution, conf };
  });

  if (!rows.length) return null;

  const totalWeight = rows.reduce((a, r) => a + r.weight, 0);
  const positive = rows.reduce((a, r) => a + r.contribution, 0);
  const computedScore = totalWeight > 0 ? positive / totalWeight : 0;

  // grafischer, gestapelter Balken: ein Segment je Regel proportional zum Weight
  const segments = rows
  .sort((a, b) => a.slug.localeCompare(b.slug))
  .map((r) => ({
    key: r.slug,
    widthPct: totalWeight > 0 ? (r.weight / totalWeight) * 100 : 0,
    color: r.result ? POS : NEG,
    label: r.slug,
    tooltip: `${r.slug} • Weight ${r.weight.toFixed(2)} • ${r.result ? "zählt" : "zählt nicht"}`,
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
                Positive Contribution: {positive.toFixed(2)}
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
                    <TableCell align="center">{r.result ? "✅ Ja" : "❌ Nein"}</TableCell>
                    <TableCell align="center" sx={{ color: r.result ? POS : "text.disabled" }}>
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
