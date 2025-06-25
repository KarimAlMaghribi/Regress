import React from 'react';
import { Box, IconButton } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import Sidebar from './Sidebar';

const expandedWidth = 240;
const collapsedWidth = 80;

export default function Layout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(true);

  const handleToggle = () => {
    setOpen((o) => !o);
  };

  return (
    <Box sx={{ display: 'flex' }}>

      <Sidebar
        open={open}
        onToggle={handleToggle}
        onClose={() => setOpen(false)}
      />

      <Box
        component="main"
        sx={{
          mt: 0,
          ml: open ? `${expandedWidth}px` : `${collapsedWidth}px`,
          p: 3,
          flexGrow: 1,
          transition: 'margin-left 0.2s',
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
