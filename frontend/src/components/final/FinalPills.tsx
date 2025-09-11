import * as React from "react";
import { Chip, Stack, Tooltip, Box } from "@mui/material";
import { fmtVal, confVariant, confColor, boolColor } from "./finalUtils";

type KV<T = any> = Record<string, T>;

/** Zeigt finale, konsolidierte Extraktionsfelder als Chips. */
export function FinalExtractionPills({ extracted }: { extracted?: KV }) {
  if (!extracted || Object.keys(extracted).length === 0) return null;
  return (
      <Stack direction="row" flexWrap="wrap" gap={1}>
        {Object.entries(extracted).map(([k, v]: any) => (
            <Tooltip
                key={k}
                title={`Conf: ${((v?.confidence ?? 0) * 100).toFixed(0)}%` + (v?.page != null ? ` · Seite ${v.page}` : "")}
            >
              <Chip
                  size="small"
                  label={`${k}: ${fmtVal(v?.value)} (${(v?.confidence ?? 0).toFixed(2)})`}
                  variant={confVariant(v?.confidence)}
                  color={confColor(v?.confidence)}
              />
            </Tooltip>
        ))}
      </Stack>
  );
}

/** Zeigt finale Scoring-Entscheidungen als Chips (Ja/Nein). */
export function FinalScoringPills({ scores }: { scores?: KV }) {
  if (!scores || Object.keys(scores).length === 0) return null;
  return (
      <Stack direction="row" flexWrap="wrap" gap={1}>
        {Object.entries(scores).map(([k, v]: any) => (
            <Tooltip key={k} title={`T=${v?.votes_true ?? 0} / F=${v?.votes_false ?? 0}`}>
              <Chip
                  size="small"
                  label={`${k}: ${v?.result ? "Ja" : "Nein"} (${(v?.confidence ?? 0).toFixed(2)})`}
                  variant={confVariant(v?.confidence)}
                  color={v?.result ? "success" : "error"}
              />
            </Tooltip>
        ))}
      </Stack>
  );
}

/** Zeigt finale Decision-Routen als Chips (YES/NO o. benannte Route). */
export function FinalDecisionPills({ decisions }: { decisions?: KV }) {
  if (!decisions || Object.keys(decisions).length === 0) return null;
  return (
      <Stack direction="row" flexWrap="wrap" gap={1}>
        {Object.entries(decisions).map(([k, v]: any) => (
            <Tooltip key={k} title={`Conf: ${((v?.confidence ?? 0) * 100).toFixed(0)}%`}>
              <Chip
                  size="small"
                  label={`${k}: ${v?.route} (${(v?.confidence ?? 0).toFixed(2)})`}
                  variant={confVariant(v?.confidence)}
                  color={boolColor(v?.answer)}
              />
            </Tooltip>
        ))}
      </Stack>
  );
}

/** Kompakter Header für Run-Details: drei Reihen (Extraction/Scoring/Decision). */
export function FinalHeader({
                              extracted,
                              scores,
                              decisions,
                            }: {
  extracted?: KV;
  scores?: KV;
  decisions?: KV;
}) {
  if (
      (!extracted || Object.keys(extracted).length === 0) &&
      (!scores || Object.keys(scores).length === 0) &&
      (!decisions || Object.keys(decisions).length === 0)
  ) {
    return null;
  }
  return (
      <Box sx={{ display: "grid", gap: 1, mb: 2 }}>
        <FinalExtractionPills extracted={extracted} />
        <FinalScoringPills scores={scores} />
        <FinalDecisionPills decisions={decisions} />
      </Box>
  );
}

/** Mini-Komponente für die „Final“-Tabellenspalte in /analyses. */
export function FinalSnapshotCell({ result }: { result?: any }) {
  const ex = Object.values(result?.extracted ?? {}) as any[];
  const low = ex.some((v: any) => (v?.confidence ?? 1) < 0.6);
  const decisions = result?.decisions ?? {};
  const decLabel = Object.entries(decisions)
  .map(([k, v]: any) => `${k}: ${v.route} (${(v.confidence ?? 0).toFixed(2)})`)
  .slice(0, 2)
  .join(" · ");

  return (
      <Stack direction="row" flexWrap="wrap" gap={0.5}>
        <Chip size="small" label={`Felder: ${ex.length}`} />
        {low && <Chip size="small" color="warning" label="Low conf" />}
        {decLabel && <Chip size="small" variant="outlined" label={decLabel} />}
      </Stack>
  );
}
