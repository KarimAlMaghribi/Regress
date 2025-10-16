import React from 'react';
import { Breadcrumbs, Typography, Box, Chip, Stack, Paper } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { alpha, useTheme } from '@mui/material/styles';

interface PageHeaderProps {
  title: string;
  actions?: React.ReactNode;
  breadcrumb?: { label: string; to?: string }[];
  icon?: React.ReactNode; // optionales Icon links neben dem Titel
  subtitle?: string;      // optionale Unterzeile
  tone?: 'default' | 'primary' | 'secondary' | 'info' | 'success' | 'warning' | 'error'; // farbliche Akzentuierung
  tag?: string;           // optionales rechtes Tag/Chip
}

export default function PageHeader({
                                     title,
                                     actions,
                                     breadcrumb,
                                     icon,
                                     subtitle,
                                     tone = 'default',
                                     tag,
                                   }: PageHeaderProps) {
  const theme = useTheme();
  const toneColor =
    tone === 'default'
      ? theme.palette.primary.main
      : (theme.palette[tone]?.main ?? theme.palette.primary.main);
  return (
    <Box sx={{ mb: { xs: 4, md: 6 } }}>
      <Paper
        variant="outlined"
        sx={{
          position: 'relative',
          overflow: 'hidden',
          px: { xs: 3, md: 4 },
          py: { xs: 3, md: 4 },
          borderRadius: 'var(--radius-card)',
          backgroundColor:
            tone === 'default'
              ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.08)
              : alpha(toneColor, theme.palette.mode === 'dark' ? 0.22 : 0.12),
          borderColor: alpha(toneColor, 0.25),
          boxShadow: 'none',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: { xs: 'auto -18% -40% auto', md: '-40% -18% auto auto' },
            width: { xs: 180, md: 320 },
            height: { xs: 180, md: 320 },
            borderRadius: '50%',
            background: alpha(toneColor, 0.08),
            pointerEvents: 'none',
          }}
        />
        <Box sx={{ position: 'relative' }}>
          {breadcrumb && (
            <Breadcrumbs sx={{ mb: 1.5 }} separator="›" aria-label="Breadcrumb">
              {breadcrumb.map((b, idx) =>
                b.to ? (
                  <Typography
                    key={idx}
                    component={RouterLink}
                    to={b.to}
                    color="primary"
                    sx={{ textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}
                  >
                    {b.label}
                  </Typography>
                ) : (
                  <Typography key={idx} fontSize="0.875rem" color="text.secondary">
                    {b.label}
                  </Typography>
                ),
              )}
            </Breadcrumbs>
          )}

          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={{ xs: 3, md: 4 }}
            alignItems={{ xs: 'flex-start', md: 'center' }}
            justifyContent="space-between"
          >
            <Stack direction="row" spacing={2.5} alignItems={{ xs: 'flex-start', md: 'center' }}>
              {icon && (
                <Box
                  aria-hidden
                  sx={{
                    width: 56,
                    height: 56,
                    borderRadius: 'var(--radius-button)',
                    display: 'grid',
                    placeItems: 'center',
                    background: alpha(toneColor, 0.16),
                    color: tone === 'default' ? 'primary.main' : `${tone}.main`,
                    boxShadow: `0 10px 24px ${alpha(toneColor, 0.18)}`,
                  }}
                >
                  {icon}
                </Box>
              )}

              <Box>
                {subtitle && (
                  <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 0.5 }}>
                    {subtitle}
                  </Typography>
                )}
                <Typography variant="h2" sx={{ fontSize: { xs: '1.75rem', md: '2rem' }, lineHeight: 1.2 }}>
                  {title}
                </Typography>
              </Box>
            </Stack>

            <Stack direction="row" spacing={1.5} alignItems="center">
              {tag && (
                <Chip
                  size="medium"
                  label={tag}
                  color={tone === 'default' ? 'default' : tone}
                  variant={tone === 'default' ? 'outlined' : 'filled'}
                  sx={{ fontWeight: 600 }}
                />
              )}
              <Box>{actions}</Box>
            </Stack>
          </Stack>
        </Box>
      </Paper>
    </Box>
  );
}
