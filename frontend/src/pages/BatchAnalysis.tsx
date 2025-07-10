import React, { useEffect, useState } from "react";
import {
  Box,
  Paper,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  ListItemText,
  List,
  ListItem,
  Typography,
} from "@mui/material";
import PageHeader from "../components/PageHeader";

interface Prompt {
  id: number;
  text: string;
}
interface Pdf {
  id: number;
}
interface Job {
  id: number;
  status: string;
  result?: string;
}

export default function BatchAnalysis() {
  const [pdfs, setPdfs] = useState<Pdf[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedPdfs, setSelectedPdfs] = useState<number[]>([]);
  const [promptId, setPromptId] = useState<number | "">("");
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    const textUrl = import.meta.env.VITE_TEXT_URL || "http://localhost:8083";
    fetch(`${textUrl}/texts`)
      .then((r) => r.json())
      .then((d) => setPdfs(d));
    fetch("http://localhost:8082/prompts")
      .then((r) => r.json())
      .then((d) => setPrompts(d));
  }, []);

  const analyze = () => {
    const classifier =
      import.meta.env.VITE_CLASSIFIER_URL || "http://localhost:8084";
    const prompt = prompts.find((p) => p.id === promptId)?.text || "";
    selectedPdfs.forEach((id) => {
      setJobs((j) => [...j, { id, status: "running" }]);
      fetch(`${classifier}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, prompt }),
      })
        .then(() => pollResult(classifier, id))
        .catch(() => updateJob(id, "error"));
    });
    setSelectedPdfs([]);
  };

  const updateJob = (id: number, status: string, result?: string) => {
    setJobs((j) =>
      j.map((job) => (job.id === id ? { ...job, status, result } : job)),
    );
  };

  const pollResult = async (url: string, id: number) => {
    while (true) {
      const res = await fetch(`${url}/results/${id}`);
      if (res.status === 202 || res.status === 404) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!res.ok) {
        updateJob(id, "error");
        break;
      }
      const d = await res.json();
      updateJob(id, "done", d.regress ? "Regressfall" : "Kein Regressfall");
      break;
    }
  };

  return (
    <Box>
      <PageHeader
        title="Batch Analysis"
        breadcrumb={[{ label: "Dashboard", to: "/" }, { label: "Batch" }]}
      />
      <Paper sx={{ p: 2, mb: 2 }}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="prompt-label">Prompt</InputLabel>
          <Select
            labelId="prompt-label"
            value={promptId}
            label="Prompt"
            onChange={(e) => setPromptId(Number(e.target.value))}
          >
            {prompts.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.text}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <List>
          {pdfs.map((p) => (
            <ListItem key={p.id}>
              <Checkbox
                checked={selectedPdfs.includes(p.id)}
                onChange={(e) => {
                  if (e.target.checked) setSelectedPdfs((s) => [...s, p.id]);
                  else setSelectedPdfs((s) => s.filter((x) => x !== p.id));
                }}
              />
              <ListItemText primary={`PDF ${p.id}`} />
            </ListItem>
          ))}
        </List>
        <Button
          variant="contained"
          onClick={analyze}
          disabled={!promptId || selectedPdfs.length === 0}
        >
          Analyze
        </Button>
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          Analysen
        </Typography>
        <List>
          {jobs.map((j) => (
            <ListItem key={j.id}>
              <ListItemText
                primary={`PDF ${j.id}`}
                secondary={j.result || j.status}
              />
            </ListItem>
          ))}
        </List>
      </Paper>
    </Box>
  );
}
