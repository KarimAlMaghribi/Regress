import React from 'react';
import { Breadcrumbs, Typography, Box } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

interface PageHeaderProps {
  title: string;
  actions?: React.ReactNode;
  breadcrumb?: { label: string; to?: string }[];
}

export default function PageHeader({ title, actions, breadcrumb }: PageHeaderProps) {
  return (
    <Box sx={{ position: 'sticky', top: 0, zIndex: 1, mb: 4, bgcolor: 'background.paper', px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
      {breadcrumb && (
        <Breadcrumbs sx={{ mb: 0.5 }}>
          {breadcrumb.map((b, idx) => b.to ? (
            <Typography key={idx} component={RouterLink} to={b.to} color="primary" fontSize="0.875rem" sx={{ textDecoration: 'none' }}>{b.label}</Typography>
          ) : (
            <Typography key={idx} fontSize="0.875rem">{b.label}</Typography>
          ))}
        </Breadcrumbs>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h5">{title}</Typography>
        <Box>{actions}</Box>
      </Box>
    </Box>
  );
}
