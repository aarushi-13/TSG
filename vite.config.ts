import { defineConfig, loadEnv, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import { handleSummarize } from './server/summarize.js'

/** Mounts the same summary handler used by the production Node service for local Vite development. */
function summarizeApi(): PluginOption {
  return {
    name: 'tsg-summarize-api',
    configureServer(server) {
      server.middlewares.use('/api/summarize', (request, response, next) => {
        void handleSummarize(request, response).catch(next)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Vite exposes only VITE_* variables, and to the client at that. GROQ_API_KEY is a server secret,
  // so the GROQ_* entries in .env are read here and handed to the dev-only summarize middleware
  // through process.env — the same thing `--env-file` does for `npm start`. Already exported shell
  // variables win, and none of this reaches the client bundle.
  const fileEnv = loadEnv(mode, process.cwd(), 'GROQ_')
  for (const [name, value] of Object.entries(fileEnv)) {
    if (value && !process.env[name]) process.env[name] = value
  }
  return { plugins: [react(), summarizeApi()], cacheDir: './node_modules/.vite' }
})
