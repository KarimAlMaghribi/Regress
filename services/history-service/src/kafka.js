import { Kafka } from 'kafkajs';
import dotenv from 'dotenv';
import { insert } from './db.js';
import { broadcast } from './websocket.js';

dotenv.config({ path: process.env.CONFIG || undefined });

const broker = process.env.MESSAGE_BROKER_URL || 'localhost:9092';

const kafka = new Kafka({ brokers: [broker] });
const consumer = kafka.consumer({ groupId: 'history-service' });

export async function startKafka() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'classification-result', fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const data = JSON.parse(message.value.toString());
        const entry = {
          id: data.id,
          result: { regress: data.regress },
          pdfUrl: `http://pdf-ingest:8081/pdf/${data.id}`,
          timestamp: new Date().toISOString()
        };
        await insert(entry);
        broadcast(entry);
      } catch (e) {
        console.error('Kafka message error', e);
      }
    }
  });
  consumer.on('consumer.crash', async () => {
    console.error('Kafka consumer crashed, reconnecting...');
    setTimeout(startKafka, 5000);
  });
}
