import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import './db.js'
import authRouter from './routes/auth.js'
import sitesRouter from './routes/sites.js'
import categoriesRouter from './routes/categories.js'
import aiRouter from './routes/ai.js'
import settingsRouter from './routes/settings.js'
import { errorHandler } from './middleware.js'

const app = express()

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
].filter(Boolean) as string[]

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true)
    else cb(null, allowedOrigins[0])
  },
  credentials: true,
}))

app.use(express.json())

app.get('/', (_req, res) => res.json({ service: 'design-nav-backend', status: 'ok', docs: '/health' }))
app.get('/health', (_req, res) => res.json({ ok: true }))

app.use('/auth', authRouter)
app.use('/sites', sitesRouter)
app.use('/categories', categoriesRouter)
app.use('/ai', aiRouter)
app.use('/settings', settingsRouter)

app.use(errorHandler)

const PORT = Number(process.env.PORT ?? 3001)
app.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT}`)
})
