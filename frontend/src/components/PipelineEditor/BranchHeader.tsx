import { Box, IconButton, Chip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ExpandMore from '@mui/icons-material/ExpandMore';
import ChevronRight from '@mui/icons-material/ChevronRight';

export default function BranchHeader({
  branchKey,
  collapsed,
  onToggle,
  onAdd,
}: {
  branchKey: string;
  collapsed: boolean;
  onToggle(): void;
  onAdd(): void;
  cKey?: string;      /* keep API unchanged, new prop is optional */
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', pl: 4, py: 0.5 }}>
      <IconButton size="small" onClick={onToggle}>
        {collapsed ? <ChevronRight fontSize="small" /> : <ExpandMore fontSize="small" />}
      </IconButton>
      <Chip label={branchKey} size="small" sx={{ mr: 1 }} />
      <IconButton size="small" onClick={onAdd}><AddIcon fontSize="small" /></IconButton>
    </Box>
  );
}
