import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({mode}) => {
  // Read only the port into Vite's server configuration; credentials never reach the client bundle.
  const env=loadEnv(mode,fileURLToPath(new URL('../..',import.meta.url)),'API_PORT');
  const port=process.env.API_PORT??env.API_PORT??'3000';
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw new Error('Invalid API_PORT');
  const target=`http://127.0.0.1:${port}`;
  return {
    plugins: [tailwindcss()],
    server: { proxy: { '/health': target, '/api': target, '/auth': target, '/mcp': target } },
  };
});
