import React from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { useTenants } from '../hooks/useTenants';

type Props = {
  value?: string;
  onChange: (tenantName?: string) => void;
  label?: string;
};

export default function TenantFilter({ value, onChange, label = 'Tenant' }: Props) {
  const { items } = useTenants();
  const names = items.map(t => t.name);
  return (
      <Autocomplete
          options={names}
          value={value || null}
          onChange={(_, val) => onChange(val ?? undefined)}
          renderInput={(params) => <TextField {...params} label={label} placeholder="nach Name filtern" size="small" />}
          sx={{ minWidth: 240 }}
          clearOnBlur
          freeSolo
      />
  );
}
