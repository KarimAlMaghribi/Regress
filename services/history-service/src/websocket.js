import { WebSocketServer } from 'ws';
import { latest } from './db.js';

let wss;
export function initWSS(server) {
  wss = new WebSocketServer({ server });
  wss.on('connection', async ws => {
    const history = await latest(50);
    ws.send(JSON.stringify({ type: 'history', data: history }));
  });
}

export function broadcast(entry) {
  if (!wss) return;
  const msg = JSON.stringify({ type: 'update', data: entry });
  wss.clients.forEach(c => {
    if (c.readyState === 1) {
      c.send(msg);
    }
  });
}
