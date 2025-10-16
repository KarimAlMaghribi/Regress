import React, { useEffect, useRef } from 'react';
import { Box, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Divider } from '@mui/material';
import { Link, useLocation } from 'react-router-dom';
import MenuIcon from '@mui/icons-material/Menu';
import DashboardIcon from '@mui/icons-material/Dashboard';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import UploadIcon from '@mui/icons-material/Upload';
import BuildIcon from '@mui/icons-material/Build';
import HistoryIcon from '@mui/icons-material/History';
import ListAltIcon from '@mui/icons-material/ListAlt';
import SettingsIcon from '@mui/icons-material/Settings';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import AssessmentIcon from '@mui/icons-material/Assessment'; // neu: für "Analyses"
import DomainIcon from '@mui/icons-material/Domain'; // neu: für "Tenants"
import { motion } from 'framer-motion';
import { alpha, useTheme } from '@mui/material/styles';
import logoWhite from '../imgs/logo_white.svg';
import logoBlack from '../imgs/logo_black.svg';

export interface SidebarProps {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  hasNewPrompts?: boolean;
}

const collapsedWidth = 80;
const expandedWidth = 240;

interface SidebarItem {
  text: string;
  to: string;
  icon: React.ReactNode;
  badge?: boolean;
}

export default function Sidebar({ open, onToggle, onClose, hasNewPrompts }: SidebarProps) {
  const theme = useTheme();
  const logo = theme.palette.mode === 'dark' ? logoWhite : logoBlack;
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  const primary: SidebarItem[] = [
    { text: 'Dashboard', to: '/', icon: <DashboardIcon /> },
    { text: 'Pipeline', to: '/pipeline', icon: <BuildIcon /> },
    { text: 'Analyses', to: '/analyses', icon: <AssessmentIcon /> },
    { text: 'History', to: '/history', icon: <HistoryIcon /> },
    { text: 'Tenants', to: '/tenants', icon: <DomainIcon /> },
    { text: 'Prompts', to: '/prompts', icon: <ListAltIcon />, badge: hasNewPrompts },
  ];

  const secondary: SidebarItem[] = [
    { text: 'Upload', to: '/upload', icon: <CloudUploadIcon /> },
    { text: 'SharePoint Upload', to: '/ingest', icon: <UploadIcon /> },
    { text: 'Settings', to: '/settings', icon: <SettingsIcon /> },
    { text: 'Help', to: '/help', icon: <HelpOutlineIcon /> },
  ];

  const renderItem = (item: SidebarItem) => {
    const active = location.pathname === item.to;
    const itemColor = theme.palette.primary.main;
    const hoverBackground = alpha(itemColor, theme.palette.mode === 'dark' ? 0.25 : 0.12);
    const activeBackground = alpha(itemColor, theme.palette.mode === 'dark' ? 0.3 : 0.16);
    return (
        <ListItemButton
            key={item.text}
            component={motion(Link)}
            to={item.to}
            whileHover={{ x: 4 }}
            selected={active}
            sx={{
              justifyContent: open ? 'flex-start' : 'center',
              px: open ? 2 : 0,
              borderRadius: 1,
              position: 'relative',
              mb: 0.5,
              color: active ? itemColor : 'text.primary',
              transition: 'background-color 0.3s ease, color 0.3s ease',
              ...(active && {
                borderLeft: '4px solid',
                borderColor: itemColor,
                backgroundColor: activeBackground,
                '& .MuiListItemIcon-root': {
                  color: itemColor,
                },
                '& .MuiTypography-root': {
                  color: itemColor,
                },
              }),
              '&:hover': {
                backgroundColor: hoverBackground,
                color: itemColor,
                '& .MuiListItemIcon-root': {
                  color: itemColor,
                },
                '& .MuiTypography-root': {
                  color: itemColor,
                },
              },
            }}
        >
          <ListItemIcon
              sx={{
                minWidth: 32,
                color: itemColor,
                mr: open ? 2 : 0,
                justifyContent: 'center',
                transition: 'color 0.3s ease',
              }}
          >
            {item.icon}
          </ListItemIcon>
          {open && (
              <ListItemText
                  primary={item.text}
                  primaryTypographyProps={{
                    sx: {
                      transition: 'color 0.3s ease',
                    },
                  }}
              />
          )}
          {item.badge && (
              <Box
                  sx={{
                    position: 'absolute',
                    right: open ? 16 : 8,
                    top: 12,
                    width: 8,
                    height: 8,
                    bgcolor: 'secondary.main',
                    borderRadius: '50%',
                  }}
              />
          )}
        </ListItemButton>
    );
  };

  return (
      <Box
          ref={ref}
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            height: '100%',
            width: open ? expandedWidth : collapsedWidth,
            transition: 'width 0.2s',
            borderRight: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 1100,
            overflowX: 'hidden',
          }}
      >
        <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              width: '100%',
              p: 1,
              gap: 1,
            }}
        >
          <Box
              component="img"
              src={logo}
              alt="Regress logo"
              sx={{ width: open ? 120 : 40, transition: 'width 0.2s' }}
          />
          <IconButton
              onClick={onToggle}
              size="small"
              sx={{ alignSelf: open ? 'flex-end' : 'center' }}
          >
            <MenuIcon />
          </IconButton>
        </Box>
        <List sx={{ flexGrow: 1 }}>
          {primary.map(renderItem)}
          <Divider sx={{ my: 1 }} />
          {secondary.map(renderItem)}
        </List>
        <Box sx={{ p: 1 }} />
      </Box>
  );
}
