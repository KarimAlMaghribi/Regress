import React from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  useTheme,
} from '@mui/material';
import {alpha} from '@mui/material/styles';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import BuildIcon from '@mui/icons-material/Build';
import HistoryIcon from '@mui/icons-material/History';
import InsightsIcon from '@mui/icons-material/Insights';
import TextSnippetIcon from '@mui/icons-material/TextSnippet';
import DomainIcon from '@mui/icons-material/Domain';
import SettingsIcon from '@mui/icons-material/Settings';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import {Link as RouterLink} from 'react-router-dom';
import {motion} from 'framer-motion';

const workflowSteps: Array<{
  title: string;
  description: string;
  links: Array<{ label: string; to: string }>;
}> = [
  {
    title: '1. Mandanten & Zugriff vorbereiten',
    description:
        'Unter /tenants werden Mandanten angelegt und verwaltet. Jeder Upload verlangt eine tenant_id und kann dadurch sauber getrennt ausgewertet werden.',
    links: [
      {label: 'Mandanten verwalten', to: '/tenants'},
      {label: 'Upload starten', to: '/upload'},
    ],
  },
  {
    title: '2. Prompts kuratieren',
    description:
        'In /prompts lassen sich Extraction-, Scoring- und Decision-Prompts definieren. Gewichtungen, JSON Keys und Favoriten helfen bei der Wiederverwendung in Pipelines.',
    links: [
      {label: 'Prompt-Bibliothek öffnen', to: '/prompts'},
    ],
  },
  {
    title: '3. Pipelines modellieren',
    description:
        'Über /pipeline werden Pipelines angelegt, Schritte konfiguriert und Reihenfolgen festgelegt. Der Editor unterstützt Typ-spezifische Einstellungen wie Mindest-Signal für Scoring.',
    links: [
      {label: 'Pipeline-Übersicht', to: '/pipeline'},
    ],
  },
  {
    title: '4. Dokumente ingestieren',
    description:
        'PDFs können per Drag & Drop in /upload geladen und optional direkt einer Pipeline zugewiesen werden. Alternativ synchronisiert /ingest SharePoint-Verzeichnisse in geplanten Jobs.',
    links: [
      {label: 'PDF Upload', to: '/upload'},
      {label: 'SharePoint Ingest', to: '/ingest'},
    ],
  },
  {
    title: '5. Läufe überwachen',
    description:
        'Die History (/history) liefert Live-Updates via WebSocket, Filter nach Datum, Pipeline oder Tenant und öffnet Run-Details direkt in einer Seitenleiste.',
    links: [
      {label: 'History', to: '/history'},
      {label: 'Runs im Detail', to: '/analyses'},
    ],
  },
  {
    title: '6. Ergebnisse analysieren & iterieren',
    description:
        'Detaillierte Resultate mit Extraktionen, Scoring und Entscheidungspfaden finden sich unter /result/:id sowie im Analysis-Bereich. Entscheidungen lassen sich dort gegen das PDF prüfen.',
    links: [
      {label: 'Analysen Übersicht', to: '/analyses'},
    ],
  },
];

const moduleCards: Array<{
  title: string;
  to: string;
  icon: React.ReactNode;
  intro: string;
  bullets: string[];
}> = [
  {
    title: 'Dashboard',
    to: '/',
    icon: <HelpOutlineIcon fontSize="large" />,
    intro: 'Schneller Einstieg mit Zugriff auf alle Kernmodule.',
    bullets: [
      'Verlinkt alle Aktions-, Analyse- und Verwaltungsbereiche.',
      'Zeigt empfohlene nächste Schritte für neue Nutzer:innen.',
    ],
  },
  {
    title: 'Upload',
    to: '/upload',
    icon: <UploadFileIcon fontSize="large" />,
    intro: 'Manueller Upload und Pipeline-Zuweisung von PDFs.',
    bullets: [
      'Status, OCR-Fortschritt und Layout-Checks live im Grid.',
      'Pipelineauswahl direkt im Datensatz möglich, inklusive Trigger.',
      'Extrahierte Texte können als JSON heruntergeladen werden.',
    ],
  },
  {
    title: 'SharePoint Upload',
    to: '/ingest',
    icon: <CloudUploadIcon fontSize="large" color="success" />,
    intro: 'Synchronisation kompletter SharePoint-Ordner.',
    bullets: [
      'Ordner browsen, Jobs mit Priorisierung erstellen.',
      'Jobstatus überwachen sowie pausieren, fortsetzen oder erneut starten.',
      'Fehlerhinweise aus dem Backend werden direkt angezeigt.',
    ],
  },
  {
    title: 'Pipelines',
    to: '/pipeline',
    icon: <BuildIcon fontSize="large" />,
    intro: 'Konfiguration der gesamten Verarbeitungskette.',
    bullets: [
      'Lineare und verzweigende Abläufe mit Drag & Drop anpassbar.',
      'Typ-spezifische Einstellungen (z. B. Mindest-Signal für Scoring).',
      'Änderungen werden sofort lokal übernommen und können persistiert werden.',
    ],
  },
  {
    title: 'Analysen',
    to: '/analyses',
    icon: <InsightsIcon fontSize="large" />,
    intro: 'Sammlung aller Runs mit direktem Zugriff auf Ergebnisse.',
    bullets: [
      'Führt in die Detailansicht einzelner Runs (/result/:id).',
      'Verlinkt auf Run-Details mit Extraktionen, Scores und Entscheidungen.',
    ],
  },
  {
    title: 'History',
    to: '/history',
    icon: <HistoryIcon fontSize="large" />,
    intro: 'Zeitlich gruppierte Run-Historie mit Live-Updates.',
    bullets: [
      'Filter nach Zeitraum, Tenant und Pipeline sowie Volltextsuche inklusive PDF-Namen.',
      'Sidepanel mit eingebettetem RunDetails-Komponent und PDF-Vorschau-Link.',
      'Schnellzugriff zum Öffnen von Runs in neuen Tabs.',
    ],
  },
  {
    title: 'Prompts',
    to: '/prompts',
    icon: <TextSnippetIcon fontSize="large" />,
    intro: 'Zentrale Verwaltung aller LLM-Promptbausteine.',
    bullets: [
      'Unterstützt drei Prompt-Typen mit eigenen Metadaten.',
      'Favoritenmarkierung und Gewichtung für wiederkehrende Scoring-Aufgaben.',
      'Direkter Link zum externen Prompt-Optimierer.',
    ],
  },
  {
    title: 'Tenants',
    to: '/tenants',
    icon: <DomainIcon fontSize="large" />,
    intro: 'Mandantenfähigkeit sicherstellen.',
    bullets: [
      'Neuanlage und Übersicht bestehender Mandanten.',
      'IDs werden für Uploads, Pipelines und History benötigt.',
    ],
  },
  {
    title: 'Settings',
    to: '/settings',
    icon: <SettingsIcon fontSize="large" />,
    intro: 'Globale Azure OpenAI-Version setzen.',
    bullets: [
      'Lädt aktuelle Konfiguration aus dem Pipeline-Backend.',
      'Speichert Änderungen per PUT-Call und zeigt Feedback an.',
    ],
  },
];

const serviceRows = [
  {
    service: 'Pipeline API',
    env: 'VITE_API_URL / VITE_PIPELINE_API_URL',
    usage: 'Lädt und speichert Pipelines, Run-Details und Einstellungen.',
  },
  {
    service: 'Prompt API',
    env: 'VITE_PROMPT_API_URL',
    usage: 'CRUD für Prompt-Bausteine aller Typen.',
  },
  {
    service: 'History API & WS',
    env: 'VITE_HISTORY_URL / VITE_HISTORY_WS',
    usage: 'Lieferung historischer Runs inkl. WebSocket-Stream für Updates.',
  },
  {
    service: 'Ingest API',
    env: 'VITE_INGEST_URL',
    usage: 'Upload von PDFs sowie Bereitstellung der konvertierten Assets.',
  },
];

const faqItems = [
  {
    question: 'Wie finde ich Runs zu einem bestimmten Dokument?',
    answer:
        'Verwende in /history die Suche. Sie berücksichtigt Pipeline-Namen, PDF-Namen und IDs. Mit der Lupe öffnest du eine Vorschlagsliste, um direkt in die Run-Details zu springen.',
  },
  {
    question: 'Wie überprüfe ich, welche Pipeline auf einen Run angewendet wurde?',
    answer:
        'In /history und /analyses zeigen die Tabellen Pipeline-ID und Namen. In der Detailansicht (/result/:id) findest du zusätzlich die Pipeline-ID im Metabereich oberhalb der Ergebnis-Widgets.',
  },
  {
    question: 'Weshalb scheitert ein Upload ohne ausgewählten Tenant?',
    answer:
        'Jeder Upload sendet tenant_id als Header und Query-Parameter. Ist kein Mandant ausgewählt, blockiert der Upload-Button. Lege zunächst unter /tenants einen Eintrag an und wähle ihn beim Upload aus.',
  },
  {
    question: 'Wie kann ich Runs erneut auslösen?',
    answer:
        'Im Upload-Gitter lässt sich pro Datensatz eine Pipeline wählen und direkt starten. Für SharePoint-Jobs nutze die Steuerung in /ingest (Pause, Resume, Retry).',
  },
];

const motionFade = {
  hidden: {opacity: 0, y: 24},
  visible: {opacity: 1, y: 0},
};

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.12,
    },
  },
};

const Help: React.FC = () => {
  const theme = useTheme();
  return (
      <Box sx={{px: {xs: 2, md: 6}, py: {xs: 4, md: 6}, display: 'flex', flexDirection: 'column', gap: 5}}>
        <Box
            component={motion.div}
            initial={{opacity: 0, y: -32}}
            animate={{opacity: 1, y: 0}}
            transition={{duration: 0.6, ease: 'easeOut'}}
            sx={{
              borderRadius: 4,
              p: {xs: 4, md: 6},
              background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.08)}, ${alpha(theme.palette.secondary.main, 0.06)})`,
              overflow: 'hidden',
              position: 'relative',
            }}
        >
          <Stack spacing={2}>
            <Typography variant="overline" color="text.secondary">Leitfaden</Typography>
            <Typography variant="h3" fontWeight={700} sx={{maxWidth: 720}}>
              Willkommen im Regress Hilfezentrum
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{maxWidth: 760}}>
              Diese Seite begleitet dich durch den vollständigen Workflow: Mandanten verwalten, Prompts kuratieren, Pipelines modellieren,
              Dokumente ingestieren und Ergebnisse analysieren. Jeder Abschnitt verlinkt direkt in die entsprechende Anwendungssicht.
            </Typography>
            <Stack direction={{xs: 'column', sm: 'row'}} spacing={2}>
              <Button
                  component={RouterLink}
                  to="/upload"
                  variant="contained"
                  size="large"
                  startIcon={<UploadFileIcon/>}
              >
                Erste Dokumente hochladen
              </Button>
              <Button
                  component={RouterLink}
                  to="/pipeline"
                  variant="outlined"
                  size="large"
                  startIcon={<BuildIcon/>}
              >
                Pipeline konfigurieren
              </Button>
            </Stack>
          </Stack>
        </Box>

        <Card id="inhalt" component={motion.div} variants={motionFade} initial="hidden" whileInView="visible" viewport={{once: true, amount: 0.3}}>
          <CardContent>
            <Typography variant="h5" gutterBottom>Inhaltsverzeichnis</Typography>
            <Stack direction={{xs: 'column', sm: 'row'}} spacing={2} useFlexGap flexWrap="wrap">
              {[{href: '#workflow', label: 'Workflow'}, {href: '#module', label: 'Module'}, {
                href: '#services', label: 'Services'
              }, {href: '#faq', label: 'FAQ'}].map((item) => (
                  <Chip
                      key={item.href}
                      label={item.label}
                      component="a"
                      href={item.href}
                      clickable
                      color="primary"
                      variant="outlined"
                  />
              ))}
            </Stack>
          </CardContent>
        </Card>

        <Box id="workflow" component={motion.div} variants={containerVariants} initial="hidden" whileInView="visible" viewport={{once: true, amount: 0.3}}>
          <Stack spacing={3}>
            <Box>
              <Typography variant="h4" gutterBottom>End-to-End Workflow</Typography>
              <Typography variant="body1" color="text.secondary">
                Folge den nummerierten Schritten, um einen wiederholbaren KI-Auswertungsprozess aufzubauen. Jeder Schritt verlinkt direkt
                in die passende Oberfläche.
              </Typography>
            </Box>
            <Stepper orientation="vertical" activeStep={workflowSteps.length} sx={{maxWidth: 920}}>
              {workflowSteps.map((step) => (
                  <Step key={step.title} expanded>
                    <StepLabel>
                      <Typography variant="h6">{step.title}</Typography>
                    </StepLabel>
                    <Box sx={{pl: 4, pb: 3}}>
                      <Typography variant="body2" color="text.secondary" sx={{mb: 1.5}}>
                        {step.description}
                      </Typography>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        {step.links.map((link) => (
                            <Chip
                                key={link.to}
                                label={link.label}
                                component={RouterLink}
                                to={link.to}
                                clickable
                                color="primary"
                                icon={<PlayArrowIcon sx={{ml: 0.5}}/>}
                            />
                        ))}
                      </Stack>
                    </Box>
                  </Step>
              ))}
            </Stepper>
          </Stack>
        </Box>

        <Box id="module" component={motion.div} variants={containerVariants} initial="hidden" whileInView="visible" viewport={{once: true, amount: 0.3}}>
          <Stack spacing={2} sx={{mb: 2}}>
            <Typography variant="h4">Module im Überblick</Typography>
            <Typography variant="body1" color="text.secondary" sx={{maxWidth: 780}}>
              Jeder Bereich der Anwendung deckt einen klaren Teilprozess ab. Die folgenden Karten beschreiben Zweck und Besonderheiten
              und führen dich direkt zur jeweiligen Route.
            </Typography>
          </Stack>
          <Grid container spacing={3}>
            {moduleCards.map((module) => (
                <Grid item xs={12} md={6} key={module.title}>
                  <Card
                      component={motion.div}
                      whileHover={{y: -6}}
                      transition={{type: 'spring', stiffness: 260, damping: 20}}
                      sx={{height: '100%'}}
                  >
                    <CardContent sx={{display: 'flex', flexDirection: 'column', gap: 2, height: '100%'}}>
                      <Stack direction="row" spacing={2} alignItems="center">
                        {module.icon}
                        <Stack spacing={0.5}>
                          <Typography variant="h6">{module.title}</Typography>
                          <Typography variant="body2" color="text.secondary">{module.intro}</Typography>
                        </Stack>
                      </Stack>
                      <Divider flexItem/>
                      <Stack spacing={1} sx={{flexGrow: 1}}>
                        {module.bullets.map((bullet) => (
                            <Stack direction="row" spacing={1.5} alignItems="flex-start" key={bullet}>
                              <Box component="span" sx={{mt: '6px', fontSize: 8}}>•</Box>
                              <Typography variant="body2" color="text.secondary">{bullet}</Typography>
                            </Stack>
                        ))}
                      </Stack>
                      <Box>
                        <Button
                            component={RouterLink}
                            to={module.to}
                            variant="outlined"
                            size="small"
                            endIcon={<PlayArrowIcon/>}
                        >
                          Seite öffnen
                        </Button>
                      </Box>
                    </CardContent>
                  </Card>
                </Grid>
            ))}
          </Grid>
        </Box>

        <Box id="services" component={motion.div} variants={motionFade} initial="hidden" whileInView="visible" viewport={{once: true, amount: 0.3}}>
          <Stack spacing={2} sx={{mb: 2}}>
            <Typography variant="h4">Technische Basis</Typography>
            <Typography variant="body1" color="text.secondary" sx={{maxWidth: 760}}>
              Die Anwendung verbindet sich mit mehreren Backend-Services. Prüfe bei Fehlern zuerst die entsprechende Basis-URL in der
              .env-Konfiguration.
            </Typography>
          </Stack>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Service</TableCell>
                <TableCell>Relevante Env-Variablen</TableCell>
                <TableCell>Funktion</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {serviceRows.map((row) => (
                  <TableRow key={row.service}>
                    <TableCell>{row.service}</TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{fontFamily: 'monospace'}}>{row.env}</Typography>
                    </TableCell>
                    <TableCell>{row.usage}</TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>

        <Box component={motion.div} variants={motionFade} initial="hidden" whileInView="visible" viewport={{once: true, amount: 0.3}}>
          <Stack spacing={2}>
            <Typography variant="h4">Troubleshooting & Tipps</Typography>
            <Stack spacing={1.5}>
              <Typography variant="body2" color="text.secondary">
                • Upload schlägt fehl? Prüfe tenant_id und ob das Ingest-Backend unter <code>VITE_INGEST_URL</code> erreichbar ist.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                • Pipeline-Änderungen verschwinden? Nutze im Editor die Speichern-Aktion des Stores (automatisch über die Toolbar) oder lade die Seite neu, um lokal gecachte Daten zu überprüfen.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                • Keine neuen Runs in der History? Kontrolliere die WebSocket-URL <code>VITE_HISTORY_WS</code> und öffne den Browser-Inspector für Netzwerkfehler.
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Weitere technische Hintergründe findest du in der Projekt-Dokumentation (z. B. <Box component="code">docs/DATA_FLOW.md</Box> und <Box component="code">docs/pipeline-api.md</Box> im Repository).
            </Typography>
          </Stack>
        </Box>

        <Box id="faq" component={motion.div} variants={containerVariants} initial="hidden" whileInView="visible" viewport={{once: true, amount: 0.3}}>
          <Typography variant="h4" gutterBottom>FAQ</Typography>
          <Stack spacing={1.5}>
            {faqItems.map((item) => (
                <Accordion key={item.question} defaultExpanded>
                  <AccordionSummary expandIcon={<ExpandMoreIcon/>}>
                    <Typography variant="subtitle1">{item.question}</Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Typography variant="body2" color="text.secondary">{item.answer}</Typography>
                  </AccordionDetails>
                </Accordion>
            ))}
          </Stack>
        </Box>
      </Box>
  );
};

export default Help;
