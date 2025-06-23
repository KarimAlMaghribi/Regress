import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Box, Typography, Paper } from '@mui/material';

export default function Upload() {
  const onDrop = useCallback((files: File[]) => {
    console.log(files);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Upload PDF</Typography>
      <Paper {...getRootProps()} sx={{ p: 4, textAlign: 'center', border: '2px dashed #bbb' }}>
        <input {...getInputProps()} />
        {isDragActive ? <p>Drop the files here...</p> : <p>Drag 'n' drop files here, or click to select</p>}
      </Paper>
    </Box>
  );
}
