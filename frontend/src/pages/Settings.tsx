import React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

const numberFormatter = new Intl.NumberFormat('de-DE');

type OptionKey = 'gpt-4o' | 'gpt-4o-mini' | 'gpt-5-mini' | 'gpt-5-chat' | 'responses';

type RateLimits = {
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  note?: string;
};

type Option = {
  key: OptionKey;
  title: string;
  tagline: string;
  description: string;
  endpoint: string;
  baseModel: {
    name: string;
    version?: string;
    lifecycleStatus?: string;
    retirementDate?: string;
  };
  deployment?: {
    type?: string;
    upgradePolicy?: string;
  };
  rateLimits?: RateLimits;
  note?: string;
};

const OPTIONS: Option[] = [
  {
    key: 'gpt-4o',
    title: 'GPT-4o',
    tagline: 'Präzision für anspruchsvolle Workflows.',
    description:
      'Starkes General-Purpose-Modell mit hoher Antwortqualität bei moderater Latenz. Ideal für finale Ausgaben oder wichtige Entscheidungen.',
    endpoint:
      'https://claims-manager.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview',
    baseModel: {
      name: 'gpt-4o',
      version: '2024-11-20',
      lifecycleStatus: 'Generally Available',
      retirementDate: '01.03.2026 · 01:00 (UTC)',
    },
    deployment: {
      type: 'Globaler Standard',
      upgradePolicy: 'Automatisches Upgrade, sobald eine neue Standardversion bereitsteht.',
    },
    rateLimits: {
      tokensPerMinute: 100_000,
      requestsPerMinute: 600,
    },
  },
  {
    key: 'gpt-4o-mini',
    title: 'GPT-4o-mini',
    tagline: 'Hohe Geschwindigkeit bei schlanken Kosten.',
    description:
      'Empfohlen für großvolumige Analysen, A/B-Tests oder wenn Antwortzeit entscheidend ist. Liefert solide Qualität zu günstigen Konditionen.',
    endpoint:
      'https://claims-manager.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview',
    baseModel: {
      name: 'gpt-4o-mini',
      version: '2024-07-18',
      lifecycleStatus: 'Generally Available',
      retirementDate: '27.02.2026 · 01:00 (UTC)',
    },
    deployment: {
      type: 'Standard',
      upgradePolicy: 'Automatischer Wechsel, sobald die aktuelle Version abläuft.',
    },
    rateLimits: {
      tokensPerMinute: 450_000,
      requestsPerMinute: 4_500,
    },
  },
  {
    key: 'gpt-5-mini',
    title: 'GPT-5 Mini',
    tagline: 'Neueste Generation in der EU-Datenzone.',
    description:
      'Aktuelles GPT-5 Mini Deployment mit EU-Datenresidenz. Liefert modernste Fähigkeiten bei strenger Compliance und kontrollierten Kosten.',
    endpoint:
      'https://claims-manager.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2025-01-01-preview',
    baseModel: {
      name: 'gpt-5-mini',
      version: '2025-08-07',
      lifecycleStatus: 'Generally Available',
      retirementDate: '08.08.2026 · 02:00 (UTC)',
    },
    deployment: {
      type: 'Datenzonenstandard (EUR)',
      upgradePolicy: 'Automatisches Upgrade, sobald eine neue Standardversion verfügbar ist.',
    },
    rateLimits: {
      tokensPerMinute: 300_000,
      requestsPerMinute: 300,
      note: 'Bereitgestellt am 06.10.2025 von kenneth.may@adesso.de (letzte Änderung 06.10.2025).',
    },
  },
  {
    key: 'gpt-5-chat',
    title: 'GPT-5 Chat',
    tagline: 'Chat-optimierte GPT-5 Bereitstellung.',
    description:
      'Nutze die dedizierte Chat-Deployment-Variante der GPT-5 Familie für dialogorientierte Features, inklusive neuester Streaming-Funktionen.',
    endpoint:
      'https://claims-manager.openai.azure.com/openai/deployments/gpt-5-chat/chat/completions?api-version=2025-01-01-preview',
    baseModel: {
      name: 'gpt-5-chat',
      version: '2025-01-01-preview',
      lifecycleStatus: 'Preview',
    },
    deployment: {
      type: 'Chat Completions',
      upgradePolicy: 'Preview-Betrieb – Änderungen erfolgen nach Freigabe durch Azure.',
    },
    rateLimits: {
      note: 'Azure veröffentlicht das konkrete Kontingent erst nach Aktivierung des Deployments. Bitte im Portal prüfen.',
    },
    note: 'Ideal, wenn du die neuesten GPT-5-Chat-Funktionen evaluieren möchtest. Beachte mögliche Funktionsänderungen während der Preview.',
  },
  {
    key: 'responses',
    title: 'Responses API',
    tagline: 'Antworten mit Tool-Aufrufen & strukturierten Ausgaben.',
    description:
      'Die Azure Responses API ermöglicht Streaming, Tool-Aufrufe und JSON-Antworten. Optimal für Agenten-Workflows mit flexiblen Ausgaben.',
    endpoint: 'https://claims-manager.openai.azure.com/openai/responses?api-version=2025-04-01-preview',
    baseModel: {
      name: 'Responses API · gpt-4o-mini',
      version: '2025-04-01-preview',
      lifecycleStatus: 'Preview',
    },
    deployment: {
      type: 'Responses API',
      upgradePolicy: 'Preview – Änderungen werden separat von Azure angekündigt.',
    },
    rateLimits: {
      note: 'Teilt sich das zugrunde liegende Kontingent mit dem gpt-4o-mini Deployment. Prüfe individuelle Limits im Azure-Portal.',
    },
    note: 'Empfohlen, wenn du Tool-Aufrufe, JSON-Outputs oder Streaming-Ergebnisse benötigst.',
  },
];

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

function lifecycleChipColor(status?: string) {
  if (!status) return 'default';
  const normalized = status.toLowerCase();
  if (normalized.includes('general')) return 'success';
  if (normalized.includes('preview')) return 'warning';
  return 'info';
}

function formatRate(value: number, unit: string) {
  return `${numberFormatter.format(value)} ${unit} pro Minute`;
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={{ xs: 0.5, sm: 2 }}
      alignItems={{ sm: 'baseline' }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          minWidth: { sm: 180 },
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontWeight: 600,
        }}
      >
        {label}
      </Typography>
      <Box flex={1}>{children}</Box>
    </Stack>
  );
}

function OptionDetails({ option, showEndpoint = true }: { option: Option; showEndpoint?: boolean }) {
  return (
    <Stack spacing={1}>
      <InfoRow label="Basismodell">
        <Typography variant="body2">{option.baseModel.name}</Typography>
      </InfoRow>
      {option.baseModel.version && (
        <InfoRow label="Modellversion">
          <Typography variant="body2">{option.baseModel.version}</Typography>
        </InfoRow>
      )}
      {option.baseModel.lifecycleStatus && (
        <InfoRow label="Lebenszyklus">
          <Chip
            size="small"
            variant="outlined"
            color={lifecycleChipColor(option.baseModel.lifecycleStatus)}
            label={option.baseModel.lifecycleStatus}
          />
        </InfoRow>
      )}
      {option.deployment?.type && (
        <InfoRow label="Bereitstellungstyp">
          <Typography variant="body2">{option.deployment.type}</Typography>
        </InfoRow>
      )}
      {option.deployment?.upgradePolicy && (
        <InfoRow label="Upgrade-Richtlinie">
          <Typography variant="body2">{option.deployment.upgradePolicy}</Typography>
        </InfoRow>
      )}
      {option.baseModel.retirementDate && (
        <InfoRow label="Modelleinstellung">
          <Typography variant="body2">{option.baseModel.retirementDate}</Typography>
        </InfoRow>
      )}
      <InfoRow label="Tokens pro Minute">
        <Typography variant="body2">
          {option.rateLimits?.tokensPerMinute !== undefined
            ? formatRate(option.rateLimits.tokensPerMinute, 'Token')
            : 'Keine Angabe'}
        </Typography>
      </InfoRow>
      <InfoRow label="Anfragen pro Minute">
        <Typography variant="body2">
          {option.rateLimits?.requestsPerMinute !== undefined
            ? formatRate(option.rateLimits.requestsPerMinute, 'Anfragen')
            : 'Keine Angabe'}
        </Typography>
      </InfoRow>
      {showEndpoint && (
        <InfoRow label="Endpoint">
          <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
            {option.endpoint}
          </Typography>
        </InfoRow>
      )}
      {option.rateLimits?.note && (
        <Typography variant="caption" color="text.secondary">
          {option.rateLimits.note}
        </Typography>
      )}
    </Stack>
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
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
        const data: ApiResponse = await res.json();
        const option = OPTIONS.find(opt => opt.key === data?.key);
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
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      setInitial(selection);
      setSuccess(true);
    } catch (e: any) {
      setError(e?.message || 'Fehler beim Speichern der Einstellung');
    } finally {
      setSaving(false);
    }
  };

  const current = React.useMemo(() => OPTIONS.find(opt => opt.key === selection) ?? OPTIONS[0], [selection]);
  const isDirty = initial !== null && selection !== initial;

  return (
    <Box p={2} maxWidth={900}>
      <Typography variant="h5" gutterBottom>
        Einstellungen
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6">Azure OpenAI Version</Typography>
            <Typography variant="body2" color="text.secondary">
              Wähle die Standard-API-Version, die im gesamten Projekt verwendet werden soll.
            </Typography>
          </Box>

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
              onChange={event => setSelection(event.target.value as OptionKey)}
              name="openai-version"
            >
              <Stack spacing={2}>
                {OPTIONS.map(option => {
                  const isSelected = selection === option.key;
                  return (
                    <Paper
                      key={option.key}
                      variant="outlined"
                      onClick={() => setSelection(option.key)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelection(option.key);
                        }
                      }}
                      tabIndex={0}
                      sx={{
                        p: 2,
                        borderColor: isSelected ? 'primary.main' : 'divider',
                        boxShadow: isSelected ? 4 : 0,
                        transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                        cursor: 'pointer',
                      }}
                    >
                      <Stack direction="row" spacing={2} alignItems="flex-start">
                        <Radio
                          value={option.key}
                          checked={isSelected}
                          onChange={event => setSelection(event.target.value as OptionKey)}
                          sx={{ mt: 0.5 }}
                        />
                        <Stack spacing={1} flexGrow={1}>
                          <Typography variant="subtitle1">{option.title}</Typography>
                          <Typography variant="body2" color="primary">
                            {option.tagline}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {option.description}
                          </Typography>
                          <Divider sx={{ my: 1 }} />
                          <OptionDetails option={option} />
                          {option.note && (
                            <Typography variant="caption" color="text.secondary">
                              {option.note}
                            </Typography>
                          )}
                        </Stack>
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            </RadioGroup>
          )}

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ sm: 'center' }}
          >
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
            <Stack direction="row" spacing={2} alignItems="flex-start">
              <InfoOutlinedIcon color="primary" sx={{ mt: 0.5 }} />
              <Box>
                <Typography variant="subtitle2">Was bedeutet das Ratenlimit?</Typography>
                <Typography variant="body2" color="text.secondary">
                  Tokens pro Minute begrenzen das Textvolumen (ca. vier Zeichen pro Token), das deine Pipelines pro Minute verarbeiten dürfen. Anfragen pro Minute definieren, wie viele API-Aufrufe im selben Zeitraum zulässig sind. Wird eines der Limits erreicht, drosselt Azure weitere Aufrufe bis zur nächsten Minute.
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Alle Deployments nutzen denselben <code>OPENAI_API_KEY</code> – setze die Variable einmalig in deiner Umgebung, um jede Option verwenden zu können.
                </Typography>
              </Box>
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2, bgcolor: 'background.default' }}>
            <Stack spacing={1}>
              <Typography variant="subtitle2">Aktive Auswahl</Typography>
              <Typography variant="body1">{current.title}</Typography>
              <Typography variant="body2" color="text.secondary">
                {current.tagline}
              </Typography>
              <Divider sx={{ my: 1 }} />
              <OptionDetails option={current} />
              {current.note && (
                <Typography variant="caption" color="text.secondary">
                  {current.note}
                </Typography>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Paper>
    </Box>
  );
}
