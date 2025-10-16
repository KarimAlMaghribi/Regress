import React from 'react';
import { Grid, Paper, Typography, Box, Stack, Button, Chip } from '@mui/material';
import PageHeader from '../components/PageHeader';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import InsightsIcon from '@mui/icons-material/Insights';
import BuildIcon from '@mui/icons-material/Build';
import SettingsIcon from '@mui/icons-material/Settings';
import DomainIcon from '@mui/icons-material/Domain';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import AssessmentIcon from '@mui/icons-material/Assessment';
import TimelineIcon from '@mui/icons-material/Timeline';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { alpha, useTheme } from '@mui/material/styles';

type ToneKey = 'primary' | 'secondary' | 'info';

interface FeatureItem {
  icon: React.ReactNode;
  title: string;
  desc: string;
  to: string;
  tone: ToneKey;
}

interface MetricTile {
  label: string;
  value: string;
  detail: string;
}

interface ReferenceItem {
  industry: string;
  title: string;
  description: string;
  to: string;
}

const featureSections: FeatureItem[] = [
  {
    icon: <BuildIcon fontSize="large" />,
    title: 'Pipeline',
    desc: 'Pipelines planen, konfigurieren und überwachen',
    to: '/pipeline',
    tone: 'primary',
  },
  {
    icon: <AssessmentIcon fontSize="large" />,
    title: 'Analysen',
    desc: 'Auswertungen vergleichen und Erkenntnisse sichern',
    to: '/analyses',
    tone: 'secondary',
  },
  {
    icon: <TimelineIcon fontSize="large" />,
    title: 'Historie',
    desc: 'Run-Historie transparent nachvollziehen',
    to: '/history',
    tone: 'info',
  },
  {
    icon: <UploadFileIcon fontSize="large" />,
    title: 'Upload',
    desc: 'Dokumente hochladen und versionieren',
    to: '/upload',
    tone: 'primary',
  },
  {
    icon: <CloudUploadIcon fontSize="large" />,
    title: 'SharePoint Upload',
    desc: 'SharePoint-Bibliotheken verbinden und synchron halten',
    to: '/ingest',
    tone: 'secondary',
  },
  {
    icon: <InsightsIcon fontSize="large" />,
    title: 'Analysis',
    desc: 'KPIs visualisieren und Trends erkennen',
    to: '/analysis',
    tone: 'info',
  },
  {
    icon: <ChatBubbleOutlineIcon fontSize="large" />,
    title: 'Prompts',
    desc: 'LLM-Prompts verwalten und freigeben',
    to: '/prompts',
    tone: 'primary',
  },
  {
    icon: <DomainIcon fontSize="large" />,
    title: 'Tenants',
    desc: 'Mandanten, Credentials und Zugriffe steuern',
    to: '/tenants',
    tone: 'secondary',
  },
  {
    icon: <SettingsIcon fontSize="large" />,
    title: 'Settings',
    desc: 'Plattformparameter zentral konfigurieren',
    to: '/settings',
    tone: 'info',
  },
];

const quickMetrics: MetricTile[] = [
  {
    label: 'Aktive Pipelines',
    value: '12',
    detail: 'davon 3 priorisiert',
  },
  {
    label: 'Ausstehende Bewertungen',
    value: '7',
    detail: 'Review durch Fachexperten',
  },
  {
    label: 'Neue Prompts',
    value: '4',
    detail: 'seit letzter Woche',
  },
];

const referenceItems: ReferenceItem[] = [
  {
    industry: 'Versicherungen',
    title: 'Automatisierte Dokumentanalyse',
    description: 'Policies werden revisionssicher geprüft – mit direkter Anbindung an die Analyseansichten.',
    to: '/analyses',
  },
  {
    industry: 'Energie',
    title: 'Regress in kritischen Pipelines',
    description: 'Stabile Deployments durch Pipeline-Orchestrierung und transparentes Monitoring.',
    to: '/pipeline',
  },
  {
    industry: 'Öffentlicher Sektor',
    title: 'Governance für KI-Modelle',
    description: 'Mehr Sicherheit durch strukturierte Prompt- und Tenant-Verwaltung.',
    to: '/prompts',
  },
];

export default function Dashboard() {
  const theme = useTheme();
  const resolveToneColor = (tone: ToneKey) => {
    switch (tone) {
      case 'secondary':
        return theme.palette.secondary.main;
      case 'info':
        return theme.palette.info.main;
      default:
        return theme.palette.primary.main;
    }
  };

  return (
    <Box>
      <PageHeader
        title="Dashboard"
        subtitle="Überblick"
        breadcrumb={[{ label: 'Dashboard' }]}
      />

      <Stack spacing={8}>
        <Box
          sx={{
            position: 'relative',
            overflow: 'hidden',
            borderRadius: 'var(--radius-card)',
            px: { xs: 4, md: 6 },
            py: { xs: 5, md: 7 },
            border: `1px solid ${alpha(theme.palette.primary.main, 0.25)}`,
            background: `linear-gradient(130deg, ${alpha(theme.palette.primary.main, 0.1)}, ${alpha(
              theme.palette.primary.dark,
              0.45,
            )})`,
            color: theme.palette.mode === 'dark' ? 'common.white' : theme.palette.text.primary,
          }}
        >
          <Box
            sx={{
              position: 'absolute',
              inset: { xs: 'auto -25% -45% auto', md: '-40% -20% auto auto' },
              width: { xs: '60%', md: '40%' },
              aspectRatio: '1 / 1',
              borderRadius: '50%',
              background: alpha(theme.palette.common.white, 0.18),
              filter: 'blur(0)',
              pointerEvents: 'none',
            }}
          />
          <Stack spacing={3} sx={{ position: 'relative' }}>
            <Chip
              icon={<CalendarTodayIcon fontSize="small" />}
              label="Regress Insights"
              color="info"
              sx={{
                alignSelf: 'flex-start',
                backgroundColor: alpha(theme.palette.common.white, theme.palette.mode === 'dark' ? 0.16 : 0.2),
                color: 'inherit',
                fontWeight: 600,
                letterSpacing: '0.04em',
              }}
            />
            <Typography variant="h2" sx={{ maxWidth: { md: '55%' } }}>
              Intelligente Qualitätssicherung für komplexe Unternehmenslandschaften
            </Typography>
            <Typography variant="body1" sx={{ maxWidth: { md: '50%' }, color: 'text.secondary' }}>
              Nutzen Sie klar strukturierte Oberflächen, um Datenflüsse zu steuern, Governance sicherzustellen und
              Ergebnisse im Team zu teilen – ohne Ihre etablierten Abläufe zu verändern.
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Button component={Link} to="/pipeline" variant="contained" color="primary" size="large">
                Pipelines öffnen
              </Button>
              <Button component={Link} to="/analyses" variant="outlined" color="primary" size="large">
                Analysen ansehen
              </Button>
            </Stack>
          </Stack>
        </Box>

        <Paper sx={{ p: { xs: 3, md: 4 } }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2 }}>
            Kennzahlen im Blick
          </Typography>
          <Grid container spacing={3}>
            {quickMetrics.map((metric) => (
              <Grid item xs={12} sm={4} key={metric.label}>
                <Stack spacing={1.5} alignItems="flex-start">
                  <Typography variant="h2" sx={{ fontSize: '2.25rem', color: 'primary.main' }}>
                    {metric.value}
                  </Typography>
                  <Typography variant="subtitle1">{metric.label}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {metric.detail}
                  </Typography>
                </Stack>
              </Grid>
            ))}
          </Grid>
        </Paper>

        <Stack spacing={3}>
          <Box>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
              Plattformmodule
            </Typography>
            <Typography variant="h2" sx={{ fontSize: { xs: '1.75rem', md: '2rem' }, mb: 1.5 }}>
              Alle zentralen Funktionen auf einen Blick
            </Typography>
          </Box>
          <Grid container spacing={3}>
            {featureSections.map((item) => (
              <Grid item xs={12} sm={6} md={4} key={item.title}>
                <Paper
                  component={motion.div}
                  whileHover={{ translateY: -6 }}
                  whileTap={{ scale: 0.98 }}
                  sx={{
                    height: '100%',
                    p: { xs: 3, md: 4 },
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    textDecoration: 'none',
                    backgroundColor: 'background.paper',
                  }}
                >
                  <Link to={item.to} style={{ textDecoration: 'none', color: 'inherit', flexGrow: 1 }}>
                    <Stack spacing={2} sx={{ flexGrow: 1 }}>
                      <Box
                        sx={{
                          width: 56,
                          height: 56,
                          borderRadius: 'var(--radius-button)',
                          display: 'grid',
                          placeItems: 'center',
                          backgroundColor: alpha(resolveToneColor(item.tone), 0.12),
                          color: resolveToneColor(item.tone),
                        }}
                      >
                        {item.icon}
                      </Box>
                      <Typography variant="h5">{item.title}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {item.desc}
                      </Typography>
                    </Stack>
                  </Link>
                  <Button
                    component={Link}
                    to={item.to}
                    color="primary"
                    variant="text"
                    endIcon={<ArrowForwardIcon fontSize="small" />}
                    sx={{ fontWeight: 600 }}
                  >
                    Mehr erfahren
                  </Button>
                </Paper>
              </Grid>
            ))}
          </Grid>
        </Stack>
      </Stack>
    </Box>
  );
}
