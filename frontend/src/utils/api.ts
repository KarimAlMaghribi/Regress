const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8084';
const INGEST_API = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';
const UPLOAD_API = import.meta.env.VITE_UPLOAD_API_URL || INGEST_API;

export {API_BASE, INGEST_API, UPLOAD_API};
