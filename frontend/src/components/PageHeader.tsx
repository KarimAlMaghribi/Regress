import React from 'react';
import { Breadcrumbs, Typography, Box, Chip } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { alpha } from '@mui/material/styles';

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
  return (
      <Box
          sx={(theme) => ({
            position: 'sticky',
            top: 0,
            zIndex: 1,
            mb: 4,
            bgcolor:
                tone === 'default'
                    ? 'background.paper'
                    : alpha(
                        (theme.palette[tone]?.main ?? theme.palette.primary.main) as string,
                        0.08
                    ),
            px: 2,
            py: 1.5,
            borderBottom: 1,
            borderColor: 'divider',
            backdropFilter: 'saturate(120%) blur(4px)',
          })}
      >
        {breadcrumb && (
            <Breadcrumbs sx={{ mb: 0.75 }}>
              {breadcrumb.map((b, idx) =>
                  b.to ? (
                      <Typography
                          key={idx}
                          component={RouterLink}
                          to={b.to}
                          color="primary"
                          fontSize="0.875rem"
                          sx={{ textDecoration: 'none' }}
                      >
                        {b.label}
                      </Typography>
                  ) : (
                      <Typography key={idx} fontSize="0.875rem">
                        {b.label}
                      </Typography>
                  )
              )}
            </Breadcrumbs>
        )}

        <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
            }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            {icon && (
                <Box
                    aria-hidden
                    sx={(theme) => ({
                      width: 40,
                      height: 40,
                      borderRadius: '12px',
                      display: 'grid',
                      placeItems: 'center',
                      bgcolor:
                          tone === 'default'
                              ? alpha(theme.palette.primary.main, 0.08)
                              : alpha(
                                  (theme.palette[tone]?.main ?? theme.palette.primary.main) as string,
                                  0.18
                              ),
                      color: tone === 'default' ? 'primary.main' : `${tone}.main`,
                      boxShadow:
                          tone === 'default'
                              ? 'none'
                              : `inset 0 0 0 1px ${alpha(
                                  (theme.palette[tone]?.main ?? theme.palette.primary.main) as string,
                                  0.25
                              )}`,
                    })}
                >
                  {icon}
                </Box>
            )}

            <Box>
              <Typography variant="h5" sx={{ lineHeight: 1.2 }}>
                {title}
              </Typography>
              {subtitle && (
                  <Typography variant="body2" color="text.secondary">
                    {subtitle}
                  </Typography>
              )}
            </Box>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {tag && (
                <Chip
                    size="small"
                    label={tag}
                    color={tone === 'default' ? 'default' : tone}
                    variant={tone === 'default' ? 'outlined' : 'filled'}
                />
            )}
            <Box>{actions}</Box>
          </Box>
        </Box>
      </Box>
  );
}
