import React from "react";
import { Autocomplete, TextField, CircularProgress } from "@mui/material";
import { useTenants } from "../hooks/useTenants";

type Props = {
  value?: string;
  onChange: (tenantName?: string) => void;
  label?: string;
};

export default function TenantFilter({ value, onChange, label = "Tenant" }: Props) {
  const { items, loading } = useTenants();
  const names = items.map(t => t.name);

  return (
      <Autocomplete
          options={names}
          loading={loading}
          value={value || null}
          onChange={(_, val) => onChange(val ?? undefined)}
          renderInput={(params) => (
              <TextField
                  {...params}
                  label={label}
                  placeholder="nach Name filtern"
                  size="small"
                  InputProps={{
                    ...params.InputProps,
                    endAdornment: (
                        <>
                          {loading ? <CircularProgress size={16} /> : null}
                          {params.InputProps.endAdornment}
                        </>
                    ),
                  }}
              />
          )}
          sx={{ minWidth: 240 }}
          clearOnBlur
          freeSolo
      />
  );
}
