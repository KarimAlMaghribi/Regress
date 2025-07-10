import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import cors from 'cors';
import { init, latest, listByStatus } from './db.js';
import { initWSS } from './websocket.js';
import { startKafka } from './kafka.js';

dotenv.config({ path: process.env.CONFIG || undefined });

const app = express();
app.use(cors());
app.use(express.json());

app.get('/classifications', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const data = await latest(limit);
  res.json(data);
});

app.get('/analyses', async (req, res) => {
  const status = req.query.status;
  console.log('list analyses', status);
  const data = await listByStatus(status);
  res.json(data);
});

const server = http.createServer(app);
initWSS(server);

const PORT = process.env.SERVER_PORT || 8090;
const HOST = process.env.SERVER_HOST || '0.0.0.0';

await init();
startKafka().catch(e => console.error('Kafka start failed', e));

server.listen(PORT, HOST, () => {
  console.log(`server running on http://${HOST}:${PORT}`);
});
