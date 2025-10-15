import React from 'react';
import { Grid, Paper, Typography, Box, Stack } from '@mui/material';
import PageHeader from '../components/PageHeader';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import InsightsIcon from '@mui/icons-material/Insights';
import HistoryIcon from '@mui/icons-material/History';
import BuildIcon from '@mui/icons-material/Build';
import SettingsIcon from '@mui/icons-material/Settings';
import DomainIcon from '@mui/icons-material/Domain';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';

const sections = [
  {
    title: 'Aktionen',
    items: [
      {
        icon: <BuildIcon fontSize="large" />,
        title: 'Pipeline',
        desc: 'Analysen starten und verwalten',
        to: '/pipeline',
      },
      {
        icon: <UploadFileIcon fontSize="large" />,
        title: 'Upload',
        desc: 'PDF-Dateien hochladen und klassifizieren',
        to: '/upload',
      },
      {
        icon: <CloudUploadIcon fontSize="large" sx={{ color: 'success.main' }} />,
        title: 'SharePoint Upload',
        desc: 'SharePoint-Dokumente synchronisieren',
        to: '/ingest',
      },
    ],
  },
  {
    title: 'Auswertungen',
    items: [
      {
        icon: <InsightsIcon fontSize="large" />,
        title: 'Analysis',
        desc: 'Metriken und Auswertungen einsehen',
        to: '/analysis',
      },
      {
        icon: <HistoryIcon fontSize="large" />,
        title: 'Analysen',
        desc: 'Laufende und abgeschlossene Analysen',
        to: '/analyses',
      },
      {
        icon: <HistoryIcon fontSize="large" color="action" />,
        title: 'Historie',
        desc: 'Vergangene Durchläufe im Detail prüfen',
        to: '/history',
      },
    ],
  },
  {
    title: 'Verwaltung',
    items: [
      {
        icon: <ChatBubbleOutlineIcon fontSize="large" />,
        title: 'Prompts',
        desc: 'LLM Prompts verwalten',
        to: '/prompts',
      },
      {
        icon: <DomainIcon fontSize="large" color="action" />,
        title: 'Tenants',
        desc: 'Mandanten und Zugänge pflegen',
        to: '/tenants',
      },
      {
        icon: <SettingsIcon fontSize="large" color="primary" />,
        title: 'Settings',
        desc: 'OpenAI-Version und Grundeinstellungen',
        to: '/settings',
      },
    ],
  },
];

export default function Dashboard() {
  return (
    <Box>
      <PageHeader title="Dashboard" breadcrumb={[{ label: 'Dashboard' }]} />
      <Stack spacing={5}>
        {sections.map(section => (
          <Box key={section.title}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              {section.title}
            </Typography>
            <Grid container spacing={3}>
              {section.items.map(item => (
                <Grid item xs={12} sm={6} md={4} key={item.title}>
                  <Paper
                    component={motion.div}
                    whileHover={{ y: -4 }}
                    whileTap={{ scale: 0.98 }}
                    sx={{ p: 4, textAlign: 'center', height: '100%' }}
                  >
                    <Link to={item.to} style={{ textDecoration: 'none', color: 'inherit' }}>
                      {item.icon}
                      <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>
                        {item.title}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {item.desc}
                      </Typography>
                    </Link>
                  </Paper>
                </Grid>
              ))}
            </Grid>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
