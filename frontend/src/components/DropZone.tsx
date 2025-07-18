import React from 'react';
import { useDropzone } from 'react-dropzone';
import { Box, Typography } from '@mui/material';

export default function DropZone({ onUpload }: { onUpload: (file: File) => void }) {
  const onDrop = React.useCallback(
    (files: File[]) => {
      if (files.length) onUpload(files[0]);
    },
    [onUpload],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  return (
    <Box
      {...getRootProps()}
      sx={{
        border: '2px dashed',
        borderColor: 'primary.main',
        borderRadius: 2,
        p: 4,
        textAlign: 'center',
        cursor: 'pointer',
      }}
    >
      <input {...getInputProps()} data-testid="drop-input" />
      <Typography variant="h3" component="div" gutterBottom>
        📄
      </Typography>
      <Typography>
        {isDragActive ? 'Ablegen zum Hochladen' : 'Datei hierher ziehen oder klicken'}
      </Typography>
    </Box>
  );
}
