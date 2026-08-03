import lmdbInstance from '../../core/lmdb/lmdbInstance'
import {
  loadStoredSyncConfig,
  refreshStoredSyncTokens,
  type StoredSyncConfig
} from '../../core/sync/syncAuthTokenService'
import type { HttpRequestOptions, HttpResponse } from '../../utils/httpRequest'
import { httpRequest } from '../../utils/httpRequest.js'

export const DEFAULT_PLUGIN_MARKET_API_BASE = 'https://z-tools.top/api/market'
export const DEFAULT_SYNC_SERVER_URL = 'wss://z-tools.top'

export class PluginMarketAuthRequiredError extends Error {
  constructor(message = '需要登录后操作') {
    super(message)
    this.name = 'PluginMarketAuthRequiredError'
  }
}

export const PluginMarketAuthMode = {
  OPTIONAL: 'optional',
  REQUIRED: 'required'
} as const

export type PluginMarketAuthMode = (typeof PluginMarketAuthMode)[keyof typeof PluginMarketAuthMode]

export function getPluginMarketApiBase(): string {
  return DEFAULT_PLUGIN_MARKET_API_BASE
}

export async function getPluginMarketAuthHeaders(
  marketApiBase = getPluginMarketApiBase()
): Promise<Record<string, string>> {
  void marketApiBase
  try {
    const config = await getStoredSyncConfig()
    if (!config?.token || config.serverUrl !== DEFAULT_SYNC_SERVER_URL) {
      return {}
    }
    return { Authorization: `Bearer ${config.token}` }
  } catch {
    return {}
  }
}

export async function requestPluginMarket(
  path: string,
  options: HttpRequestOptions = {},
  authMode: PluginMarketAuthMode = PluginMarketAuthMode.OPTIONAL
): Promise<HttpResponse> {
  const marketApiBase = getPluginMarketApiBase()
  const url = path.startsWith('http') ? path : `${marketApiBase}${path}`
  const response = await requestPluginMarketOnce(url, marketApiBase, options)
  if (response.status !== 401) {
    assertOK(response)
    return response
  }

  let refreshed = false
  try {
    refreshed = await refreshPluginMarketToken(marketApiBase)
  } catch {
    refreshed = false
  }

  if (refreshed) {
    const retry = await requestPluginMarketOnce(url, marketApiBase, options)
    if (retry.status !== 401) {
      assertOK(retry)
      return retry
    }
  }

  if (authMode === PluginMarketAuthMode.OPTIONAL) {
    const anonymousRetry = await requestPluginMarketOnce(url, marketApiBase, options, false)
    assertOK(anonymousRetry)
    return anonymousRetry
  }

  throw new PluginMarketAuthRequiredError()
}

export async function savePluginMarketTokens(input: {
  serverUrl?: string
  token: string
  refreshToken?: string
  username?: string
}): Promise<void> {
  const existingDoc = await lmdbInstance.promises.get('SYNC/config')
  const current = (existingDoc?.data || {}) as StoredSyncConfig
  const next: StoredSyncConfig = {
    ...current,
    enabled: Boolean(current.enabled),
    serverUrl: input.serverUrl || current.serverUrl || DEFAULT_SYNC_SERVER_URL,
    token: input.token,
    refreshToken: input.refreshToken || current.refreshToken || '',
    syncInterval: current.syncInterval || 30,
    lastSyncTime: current.lastSyncTime || 0,
    username: input.username || current.username
  }
  await lmdbInstance.promises.put({
    _id: 'SYNC/config',
    _rev: existingDoc?._rev,
    data: next
  })
}

async function requestPluginMarketOnce(
  url: string,
  marketApiBase: string,
  options: HttpRequestOptions,
  includeAuth = true
): Promise<HttpResponse> {
  const authHeaders = includeAuth ? await getPluginMarketAuthHeaders(marketApiBase) : {}
  const optionHeaders = includeAuth
    ? options.headers || {}
    : Object.fromEntries(
        Object.entries(options.headers || {}).filter(
          ([key]) => key.toLowerCase() !== 'authorization'
        )
      )
  return httpRequest(url, {
    ...options,
    headers: {
      ...optionHeaders,
      ...authHeaders
    },
    validateStatus: (status) => (status >= 200 && status < 300) || status === 401
  })
}

/**
 * 通过统一设备级刷新服务更新插件市场使用的官方账号 token。
 * @param marketApiBase 插件市场 API 地址；保留参数以兼容现有调用边界。
 * @returns 获得可用访问令牌时返回 true。
 */
async function refreshPluginMarketToken(marketApiBase: string): Promise<boolean> {
  void marketApiBase
  const config = await getStoredSyncConfig()
  if (!config?.refreshToken || config.serverUrl !== DEFAULT_SYNC_SERVER_URL) {
    return false
  }
  const result = await refreshStoredSyncTokens(config.refreshToken)
  return (
    (result.status === 'refreshed' || result.status === 'reused') && Boolean(result.config.token)
  )
}

/**
 * 读取插件市场认证使用的设备级同步配置。
 * @returns 当前同步配置；读取失败或未配置时返回 null。
 */
async function getStoredSyncConfig(): Promise<StoredSyncConfig | null> {
  return loadStoredSyncConfig()
}

function assertOK(response: HttpResponse): void {
  if (response.status >= 200 && response.status < 300) return
  const data = typeof response.data === 'string' ? safeParseJSON(response.data) : response.data
  throw new Error(data?.error || `Request failed with status code ${response.status}`)
}

function safeParseJSON(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

export function syncServerUrlToHttp(serverUrl: string): string {
  return serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
}
