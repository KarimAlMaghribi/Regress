import * as React from "react";
import { Box, TextField, Typography } from "@mui/material";

export type ScoringCfg = {
  min_weight_yes?: number;     // 0..1  (Votes "yes" unterhalb werden ignoriert)
  min_weight_no?: number;      // 0..1  (Votes "no"  unterhalb werden ignoriert)
  min_weight_unsure?: number;  // 0..1  (Votes "unsure" unterhalb werden ignoriert)
  label_threshold_yes?: number; // -1..+1 (Score >= Schwelle => label=yes)
  label_threshold_no?: number;  // -1..+1 (Score <= Schwelle => label=no)
};

export default function ScoringConfigFields({
                                              value,
                                              onChange,
                                            }: {
  value?: ScoringCfg;
  onChange: (cfg: ScoringCfg) => void;
}) {
  const cfg: Required<ScoringCfg> = {
    min_weight_yes:      typeof value?.min_weight_yes === "number" ? value!.min_weight_yes : 0,
    min_weight_no:       typeof value?.min_weight_no === "number" ? value!.min_weight_no : 0,
    min_weight_unsure:   typeof value?.min_weight_unsure === "number" ? value!.min_weight_unsure : 0,
    label_threshold_yes: typeof value?.label_threshold_yes === "number" ? value!.label_threshold_yes : 0.60,
    label_threshold_no:  typeof value?.label_threshold_no  === "number" ? value!.label_threshold_no  : -0.60,
  };

  const set = (k: keyof ScoringCfg, v: number) => {
    const next = { ...cfg, [k]: v };
    onChange(next);
  };

  return (
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
        <Typography variant="subtitle2" sx={{ gridColumn: "1 / -1", mt: 1 }}>
          Tri-State (Scoring) · Filter & Schwellen
        </Typography>

        <TextField
            label="Min-Gewicht YES (0..1)"
            type="number" inputProps={{ step: 0.05, min: 0, max: 1 }}
            value={cfg.min_weight_yes}
            onChange={(e) => set("min_weight_yes", Number(e.target.value))}
        />
        <TextField
            label="Min-Gewicht NO (0..1)"
            type="number" inputProps={{ step: 0.05, min: 0, max: 1 }}
            value={cfg.min_weight_no}
            onChange={(e) => set("min_weight_no", Number(e.target.value))}
        />
        <TextField
            label="Min-Gewicht UNSURE (0..1)"
            type="number" inputProps={{ step: 0.05, min: 0, max: 1 }}
            value={cfg.min_weight_unsure}
            onChange={(e) => set("min_weight_unsure", Number(e.target.value))}
        />

        <TextField
            label="Schwelle YES (−1..+1)"
            type="number" inputProps={{ step: 0.05, min: -1, max: 1 }}
            value={cfg.label_threshold_yes}
            onChange={(e) => set("label_threshold_yes", Number(e.target.value))}
        />
        <TextField
            label="Schwelle NO (−1..+1)"
            type="number" inputProps={{ step: 0.05, min: -1, max: 1 }}
            value={cfg.label_threshold_no}
            onChange={(e) => set("label_threshold_no", Number(e.target.value))}
        />

        <Typography variant="caption" color="text.secondary" sx={{ gridColumn: "1 / -1" }}>
          Stimmen mit Gewicht unterhalb der Min-Grenze werden verworfen. Das finale Label wird aus dem
          konsolidierten Score (−1..+1) mit den Schwellen abgeleitet: ≥ YES ⇒ „yes“, ≤ NO ⇒ „no“, sonst „unsure“.
        </Typography>
      </Box>
  );
}
