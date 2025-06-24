import React from 'react';
import { Grid, Paper, Typography, Box } from '@mui/material';
import PageHeader from '../components/PageHeader';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import InsightsIcon from '@mui/icons-material/Insights';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';

const cards = [
  {
    icon: <UploadFileIcon fontSize="large" />,
    title: 'Upload',
    desc: 'PDF Dateien hochladen und klassifizieren',
    to: '/upload',
  },
  {
    icon: <ChatBubbleOutlineIcon fontSize="large" />,
    title: 'Prompts',
    desc: 'LLM Prompts verwalten',
    to: '/prompts',
  },
  {
    icon: <InsightsIcon fontSize="large" />,
    title: 'Analysis',
    desc: 'Metriken und Auswertungen',
    to: '/analysis',
  },
];

export default function Dashboard() {
  return (
    <Box>
      <PageHeader title="Dashboard" breadcrumb={[{ label: 'Dashboard' }]} />
      <Grid container spacing={4}>
        {cards.map(card => (
          <Grid item xs={12} md={4} key={card.title}>
          <Paper
            component={motion.div}
            whileHover={{ y: -4 }}
            whileTap={{ scale: 0.98 }}
            sx={{ p: 4, textAlign: 'center' }}
          >
            <Link to={card.to} style={{ textDecoration: 'none', color: 'inherit' }}>
              {card.icon}
              <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>
                {card.title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {card.desc}
              </Typography>
            </Link>
          </Paper>
        </Grid>
      ))}
      </Grid>
    </Box>
  );
}
