import * as React from "react";
import { TextField, FormControlLabel, Checkbox, Stack, Button } from "@mui/material";

export interface EvidenceFilters {
  page?: number;
  onlyErrors?: boolean;
  query?: string;
}

export function EvidenceFilterBar({
                                    value,
                                    onChange,
                                    onReset,
                                  }: {
  value: EvidenceFilters;
  onChange: (v: EvidenceFilters) => void;
  onReset?: () => void;
}) {
  return (
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1, flexWrap: "wrap" }}>
        <TextField
            size="small"
            label="Seite"
            type="number"
            value={value.page ?? ""}
            onChange={(e) =>
                onChange({ ...value, page: e.target.value ? parseInt(e.target.value, 10) : undefined })
            }
            sx={{ width: 120 }}
        />
        <TextField
            size="small"
            label="Suche (Quote/Wert/Erklärung)"
            value={value.query ?? ""}
            onChange={(e) => onChange({ ...value, query: e.target.value || undefined })}
            sx={{ minWidth: 260 }}
        />
        <FormControlLabel
            control={
              <Checkbox
                  checked={!!value.onlyErrors}
                  onChange={(e) => onChange({ ...value, onlyErrors: e.target.checked })}
              />
            }
            label="Nur Fehler"
        />
        {onReset && (
            <Button variant="text" onClick={onReset}>
              Filter zurücksetzen
            </Button>
        )}
      </Stack>
  );
}
