import React, { useEffect, useState } from "react";
import {
  Box,
  Paper,
  Stack,
  TextField,
  Button,
  Typography,
  List,
  ListItem,
  ListItemText,
  Alert,
  Chip,
  Grid,
  Divider,
} from "@mui/material";
import DomainIcon from "@mui/icons-material/Domain";
import AddBusinessIcon from "@mui/icons-material/AddBusiness";
import RefreshIcon from "@mui/icons-material/Refresh";
import AssignmentIndIcon from "@mui/icons-material/AssignmentInd";
import PageHeader from "../components/PageHeader";
import { alpha, useTheme } from "@mui/material/styles";

type Tenant = { id: string; name: string };

function getHistoryBase(): string {
  const w = (window as any);
  return w?.__ENV__?.HISTORY_URL || import.meta.env.VITE_HISTORY_URL || "/hist";
}

export default function TenantsPage() {
  const theme = useTheme();
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
      setError(e.message || "Fehler beim Anlegen des Mandanten");
    }
  };

  return (
      <Stack spacing={4}>
        <PageHeader
            title="Mandanten"
            subtitle="Zugänge strukturieren und Trennung der Datenhaltung sicherstellen"
            breadcrumb={[{ label: "Dashboard", to: "/" }, { label: "Tenants" }]}
            tone="secondary"
            icon={<DomainIcon />}
            tag={`Anzahl: ${items.length}`}
            actions={
              <Button
                  variant="outlined"
                  size="small"
                  startIcon={<RefreshIcon />}
                  onClick={load}
                  disabled={loading}
              >
                Aktualisieren
              </Button>
            }
        />

        <Grid container spacing={3}>
          <Grid item xs={12} md={5}>
            <Paper
                variant="outlined"
                sx={{
                  p: { xs: 3, md: 4 },
                  borderRadius: 'var(--radius-card)',
                  boxShadow: 'var(--shadow-z1)',
                  background:
                      theme.palette.mode === 'dark'
                          ? alpha(theme.palette.primary.main, 0.12)
                          : 'linear-gradient(130deg, rgba(0,110,199,0.08), rgba(247,250,252,0.9))',
                }}
            >
              <Stack spacing={2.5}>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    Governance & Zugriff
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Mandanten kapseln Konfigurationen, Pipelines und Uploads. Pflege hier zentrale Accounts,
                    um eine klare Trennung der Verantwortlichkeiten sicherzustellen.
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  <Chip icon={<AssignmentIndIcon />} label={`${items.length} Mandanten`} color="primary" />
                  <Chip label={loading ? 'Ladevorgang aktiv' : 'Status aktuell'} variant="outlined" />
                </Stack>
              </Stack>
            </Paper>
          </Grid>

          <Grid item xs={12} md={7}>
            <Paper
                variant="outlined"
                sx={{
                  p: { xs: 3, md: 4 },
                  borderRadius: 'var(--radius-card)',
                  boxShadow: 'var(--shadow-z1)',
                }}
            >
              <Stack spacing={2.5}>
                <Stack spacing={1}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    Neuen Mandanten anlegen
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Vergib einen eindeutigen Namen. Die ID wird automatisch generiert.
                  </Typography>
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField
                      label="Mandantenname"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      fullWidth
                  />
                  <Button
                      variant="contained"
                      startIcon={<AddBusinessIcon />}
                      onClick={create}
                      disabled={!name.trim() || loading}
                      sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
                  >
                    Anlegen
                  </Button>
                </Stack>
                {error && (
                    <Alert severity="error">{error}</Alert>
                )}
              </Stack>
            </Paper>
          </Grid>
        </Grid>

        <Paper
            variant="outlined"
            sx={{
              p: { xs: 2, md: 3 },
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-z1)',
            }}
        >
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1.5}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Vorhandene Mandanten
              </Typography>
              {loading && <Typography variant="body2" color="text.secondary">Lade Daten …</Typography>}
            </Stack>
            <Divider />
            <List dense>
              {items.map((t, index) => (
                  <React.Fragment key={t.id}>
                    <ListItem
                        disableGutters
                        sx={{
                          py: 1.25,
                          px: 1,
                          borderRadius: 'var(--radius-button)',
                          '&:hover': {
                            backgroundColor:
                                theme.palette.mode === 'dark'
                                    ? alpha(theme.palette.primary.main, 0.12)
                                    : alpha(theme.palette.primary.main, 0.08),
                          },
                        }}
                    >
                      <ListItemText
                          primary={<Typography fontWeight={600}>{t.name}</Typography>}
                          secondary={<Typography variant="body2" color="text.secondary">{t.id}</Typography>}
                      />
                    </ListItem>
                    {index < items.length - 1 && <Divider component="li" sx={{ my: 0.5 }} />}
                  </React.Fragment>
              ))}
              {!items.length && (
                  <Box sx={{ py: 4, textAlign: 'center', color: 'text.secondary' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                      Noch keine Mandanten vorhanden
                    </Typography>
                    <Typography variant="body2">
                      Lege über das Formular oben den ersten Mandanten an.
                    </Typography>
                  </Box>
              )}
            </List>
          </Stack>
        </Paper>
      </Stack>
  );
}
