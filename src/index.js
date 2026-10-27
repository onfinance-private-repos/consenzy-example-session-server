import { configFromEnv, createApp } from './server.js';

const config = configFromEnv();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
createApp(config).listen(port, host, () => {
  console.log(`consenzy example session server: ${config.mode} mode on http://${host}:${port}`);
  if (config.mode === 'demo') console.log('demo mode: synthetic data, mock principal API at /v1/me (no Consenzy org needed)');
});
