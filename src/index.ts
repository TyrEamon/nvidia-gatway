import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types'
import { adminAuthMiddleware, proxyKeyAuthMiddleware, handleLogin, handleLogout } from './auth'
import { handleProxy, handleModels } from './proxy'
import {
  handleStatus,
  handleGetSettings,
  handleUpdateSettings,
  handleGetRaceWinnerLogs,
  handleExportData,
  handleImportData,
  handleGetProviders,
  handleCreateProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleTestModel,
  handleTestApiKey,
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import { seedInitialData, getSession } from './storage'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors())
app.use('*', logger())

let seeded = false
app.use('*', async (c, next) => {
  if (!seeded) {
    await seedInitialData(c.env)
    seeded = true
  }
  return next()
})

app.get('/', async (c) => {
  const { getCookie } = await import('hono/cookie')
  const sessionId = getCookie(c, 'session_id')
  let isLoggedIn = false
  if (sessionId) {
    const session = await getSession(c.env, sessionId)
    isLoggedIn = session !== null
  }
  return renderHomePage(c, isLoggedIn)
})

app.get('/admin/login', async (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
app.get('/admin/logout', handleLogout)

app.use('/admin/*', adminAuthMiddleware)

app.get('/admin', async (c) => renderAdminPage(c))

app.get('/admin/api/status', handleStatus)
app.get('/admin/api/settings', handleGetSettings)
app.put('/admin/api/settings', handleUpdateSettings)
app.get('/admin/api/race-winner-logs', handleGetRaceWinnerLogs)
app.get('/admin/api/export', handleExportData)
app.post('/admin/api/import', handleImportData)

app.get('/admin/api/providers', handleGetProviders)
app.post('/admin/api/providers', handleCreateProvider)
app.put('/admin/api/providers/:id', handleUpdateProvider)
app.delete('/admin/api/providers/:id', handleDeleteProvider)
app.post('/admin/api/providers/:id/test-model', handleTestModel)
app.post('/admin/api/test-api-key', handleTestApiKey)

app.get('/admin/api/proxy-keys', handleGetProxyKeys)
app.post('/admin/api/proxy-keys', handleCreateProxyKey)
app.delete('/admin/api/proxy-keys/:id', handleDeleteProxyKey)
app.patch('/admin/api/proxy-keys/:id', handleUpdateProxyKey)

app.use('/v1/*', proxyKeyAuthMiddleware)

app.get('/v1/models', handleModels)
app.all('/v1/*', handleProxy)

app.notFound((c) => {
  return c.json({ error: { message: '接口不存在', type: 'not_found' } }, 404)
})

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: { message: '服务器内部错误', type: 'server_error' } }, 500)
})

export default app
