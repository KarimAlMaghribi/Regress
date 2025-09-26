import React, { useEffect, useState } from "react";
import { Box, Paper, Stack, TextField, Button, Typography, List, ListItem, ListItemText } from "@mui/material";

type Tenant = { id: string; name: string };

function getHistoryBase(): string {
  const w = (window as any);
  return w?.__ENV__?.HISTORY_URL || import.meta.env.VITE_HISTORY_URL || "/hist";
}

export default function TenantsPage() {
  const [items, setItems] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const base = getHistoryBase();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/tenants`);
      if (!res.ok) throw new Error(await res.text());
      setItems(await res.json());
    } catch (e: any) {
      setError(e.message || "Fehler beim Laden der Mandanten");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [base]);

  const create = async () => {
    if (!name.trim()) return;
    try {
      const res = await fetch(`${base}/tenants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await res.text());
      setName("");
      await load();
    } catch (e: any) {
      alert(e.message || "Fehler beim Anlegen des Mandanten");
    }
  };

  return (
      <Box p={2}>
        <Typography variant="h5" gutterBottom>Mandanten</Typography>
        <Paper sx={{ p: 2, mb: 2 }}>
          <Stack direction="row" spacing={2}>
            <TextField
                label="Neuer Mandant (Name)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                fullWidth
            />
            <Button variant="contained" onClick={create} disabled={!name.trim()}>
              Anlegen
            </Button>
          </Stack>
        </Paper>
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" gutterBottom>Vorhandene Mandanten</Typography>
          {loading && <Typography>Lade …</Typography>}
          {error && <Typography color="error">{error}</Typography>}
          <List dense>
            {items.map(t => (
                <ListItem key={t.id} disableGutters>
                  <ListItemText primary={t.name} secondary={t.id} />
                </ListItem>
            ))}
          </List>
        </Paper>
      </Box>
  );
}
