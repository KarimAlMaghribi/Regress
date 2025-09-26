import React, { useState } from "react";
import { Box, Paper, Stack, TextField, Button, Typography, List, ListItem, ListItemText } from "@mui/material";
import { useTenants } from "../hooks/useTenants";

export default function TenantsPage() {
  const { items, loading, error, reload } = useTenants();
  const [name, setName] = useState("");

  const create = async () => {
    if (!name.trim()) return;
    const res = await fetch("/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      setName("");
      reload();
    } else {
      alert(await res.text());
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
