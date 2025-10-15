import React from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material';

const OPTIONS = [
  {
    key: 'gpt-4o',
    label: 'GPT-4o (2025-01-01-preview)',
    description: 'Leistungsstarkes Modell für qualitativ hochwertige Ausgaben.',
    endpoint:
      'https://claims-manager.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview',
  },
  {
    key: 'gpt-4o-mini',
    label: 'GPT-4o-mini (2025-01-01-preview)',
    description: 'Kosteneffizienter, schnellerer Modus für hohe Durchsätze.',
    endpoint:
      'https://claims-manager.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview',
  },
  {
    key: 'responses',
    label: 'Responses API (2025-04-01-preview)',
    description: 'Neue Responses API mit Streaming- und Tool-Aufrufen.',
    endpoint: 'https://claims-manager.openai.azure.com/openai/responses?api-version=2025-04-01-preview',
  },
] as const;

type OptionKey = (typeof OPTIONS)[number]['key'];

type ApiResponse = {
  key: string;
  endpoint: string;
};

function resolvePipelineApiBase(): string {
  const w = window as any;
  return (
    w?.__ENV__?.PIPELINE_API_URL ||
    (import.meta as any)?.env?.VITE_API_URL ||
    (import.meta as any)?.env?.VITE_PIPELINE_API_URL ||
    'http://localhost:8084'
  );
}

export default function Settings() {
  const [selection, setSelection] = React.useState<OptionKey>(OPTIONS[0].key);
  const [initial, setInitial] = React.useState<OptionKey | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);

  const apiBase = React.useMemo(() => resolvePipelineApiBase().replace(/\/$/, ''), []);

  React.useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/settings/openai-version`);
        if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
        const data: ApiResponse = await res.json();
        const option = OPTIONS.find((opt) => opt.key === data?.key);
        if (option && active) {
          setSelection(option.key);
          setInitial(option.key);
        } else if (active) {
          setSelection(OPTIONS[0].key);
          setInitial(OPTIONS[0].key);
        }
      } catch (e: any) {
        if (!active) return;
        setError(e?.message || 'Fehler beim Laden der Einstellungen');
        setSelection(OPTIONS[0].key);
        setInitial(OPTIONS[0].key);
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [apiBase]);

  React.useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setSuccess(false), 3000);
    return () => window.clearTimeout(timer);
  }, [success]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch(`${apiBase}/settings/openai-version`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: selection }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      setInitial(selection);
      setSuccess(true);
    } catch (e: any) {
      setError(e?.message || 'Fehler beim Speichern der Einstellung');
    } finally {
      setSaving(false);
    }
  };

  const current = React.useMemo(() => OPTIONS.find((opt) => opt.key === selection)!, [selection]);
  const isDirty = initial !== null && selection !== initial;

  return (
    <Box p={2} maxWidth={700}>
      <Typography variant="h5" gutterBottom>
        Einstellungen
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Azure OpenAI Version</Typography>
          <Typography variant="body2" color="text.secondary">
            Wähle die Standard-API-Version, die im gesamten Projekt verwendet werden soll.
          </Typography>

          {error && <Alert severity="error">{error}</Alert>}
          {success && <Alert severity="success">Einstellung gespeichert.</Alert>}

          {loading ? (
            <Stack direction="row" alignItems="center" spacing={1}>
              <CircularProgress size={20} />
              <Typography variant="body2">Lade aktuelle Einstellung …</Typography>
            </Stack>
          ) : (
            <RadioGroup
              value={selection}
              onChange={(event) => {
                setSelection(event.target.value as OptionKey);
              }}
            >
              {OPTIONS.map((option) => (
                <FormControlLabel
                  key={option.key}
                  value={option.key}
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography variant="subtitle1">{option.label}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {option.description}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {option.endpoint}
                      </Typography>
                    </Box>
                  }
                />
              ))}
            </RadioGroup>
          )}

          <Stack direction="row" spacing={2} alignItems="center">
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={loading || saving || !isDirty}
            >
              {saving ? 'Speichert …' : 'Speichern'}
            </Button>
            {!loading && !saving && !isDirty && (
              <Typography variant="body2" color="text.secondary">
                Keine Änderungen.
              </Typography>
            )}
          </Stack>

          <Paper variant="outlined" sx={{ p: 2, bgcolor: 'background.default' }}>
            <Typography variant="subtitle2" gutterBottom>
              Aktive Auswahl
            </Typography>
            <Typography variant="body1">{current.label}</Typography>
            <Typography variant="body2" color="text.secondary">
              {current.endpoint}
            </Typography>
          </Paper>
        </Stack>
      </Paper>
    </Box>
  );
}
