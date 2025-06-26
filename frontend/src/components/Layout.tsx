import React from 'react';
import { Box } from '@mui/material';
import Sidebar from './Sidebar';
import { usePromptNotifications } from '../context/PromptNotifications';

const expandedWidth = 240;
const collapsedWidth = 80;

export default function Layout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(true);
  const { unread } = usePromptNotifications();

  const handleToggle = () => {
    setOpen((o) => !o);
  };

  return (
    <Box sx={{ display: 'flex' }}>

      <Sidebar
        open={open}
        onToggle={handleToggle}
        onClose={() => setOpen(false)}
        hasNewPrompts={unread > 0}
      />

      <Box
        component="main"
        sx={{
          mt: 0,
          ml: open ? `${expandedWidth}px` : `${collapsedWidth}px`,
          width: `calc(100% - ${open ? expandedWidth : collapsedWidth}px)`,
          p: 3,
          flexGrow: 1,
          boxSizing: 'border-box',
          overflowX: 'hidden',
          transition: 'margin-left 0.2s, width 0.2s',
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
