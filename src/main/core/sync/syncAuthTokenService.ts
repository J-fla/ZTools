import { httpRequest } from '../../utils/httpRequest.js'
import type { DbDoc, DbResult } from '../lmdb/types'
import { coordinateTokenRefresh } from './tokenRefreshCoordinator'
import type { SyncConfig } from './types'

export type StoredSyncConfig = Partial<SyncConfig> & {
  serverUrl?: string
  token?: string
  refreshToken?: string
  username?: string
}

export type StoredTokenRefreshResult =
  | { status: 'refreshed' | 'reused'; config: StoredSyncConfig }
  | { status: 'invalid'; config: StoredSyncConfig }
  | { status: 'unavailable'; config: StoredSyncConfig | null; error?: unknown }

type CredentialsInvalidatedListener = (config: StoredSyncConfig) => void
type SyncConfigStore = {
  promises: {
    get: (id: string) => Promise<DbDoc | null>
    put: (doc: DbDoc) => Promise<DbResult>
  }
}

const credentialsInvalidatedListeners = new Set<CredentialsInvalidatedListener>()
let syncConfigStorePromise: Promise<SyncConfigStore> | null = null

/**
 * 从设备级路由存储读取当前同步配置。
 * @returns 当前同步配置；配置不存在或读取失败时返回 null。
 */
export async function loadStoredSyncConfig(): Promise<StoredSyncConfig | null> {
  try {
    const store = await getSyncConfigStore()
    const doc = await store.promises.get('SYNC/config')
    return (doc?.data as StoredSyncConfig | undefined) || null
  } catch {
    return null
  }
}

/**
 * 监听刷新令牌确认失效并已清理本地凭据的事件。
 * @param listener 凭据失效后的处理函数。
 * @returns 用于取消监听的清理函数。
 */
export function onSyncCredentialsInvalidated(listener: CredentialsInvalidatedListener): () => void {
  credentialsInvalidatedListeners.add(listener)
  return (): void => {
    credentialsInvalidatedListeners.delete(listener)
  }
}

/**
 * 使用设备级最新配置协调一次刷新，并以 refresh token 作为并发和账号切换边界。
 * @param expectedRefreshToken 调用方准备使用的 refresh token；省略时使用存储中的最新值。
 * @returns 刷新、复用、失效或暂时不可用的结构化结果。
 */
export async function refreshStoredSyncTokens(
  expectedRefreshToken?: string
): Promise<StoredTokenRefreshResult> {
  const latest = await loadStoredSyncConfig()
  if (!latest?.serverUrl) {
    return { status: 'unavailable', config: latest }
  }

  const refreshToken = expectedRefreshToken || latest.refreshToken
  if (!refreshToken) {
    const cleared = latest.token ? await clearStoredCredentialsIfCurrent('', latest.token) : latest
    return { status: 'invalid', config: cleared || latest }
  }

  // 存储中的 token 已变化，说明其他请求已经刷新或用户已经切换账号。
  if (latest.refreshToken !== refreshToken) {
    return { status: 'reused', config: latest }
  }

  let tokens: { token: string; refreshToken: string } | null
  try {
    tokens = await coordinateTokenRefresh(refreshToken, async () => {
      const response = await httpRequest(
        `${syncServerUrlToHttp(latest.serverUrl!)}/api/auth/refresh`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          validateStatus: () => true
        }
      )
      if (response.status === 401) return null
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Refresh token request failed with status ${response.status}`)
      }
      const data = typeof response.data === 'string' ? safeParseJSON(response.data) : response.data
      if (!data?.token || !data?.refreshToken) {
        throw new Error('Refresh token response is incomplete')
      }
      return { token: data.token, refreshToken: data.refreshToken }
    })
  } catch (error) {
    // 网络或服务端暂时异常时不清理有效凭据，交给调用方稍后重试。
    const current = await loadStoredSyncConfig()
    if (current?.refreshToken && current.refreshToken !== refreshToken) {
      return { status: 'reused', config: current }
    }
    return { status: 'unavailable', config: current, error }
  }

  if (!tokens) {
    const current = await loadStoredSyncConfig()
    if (current?.refreshToken && current.refreshToken !== refreshToken) {
      return { status: 'reused', config: current }
    }
    const cleared = await clearInvalidStoredCredentials(refreshToken)
    if (cleared?.refreshToken !== refreshToken && (cleared?.token || cleared?.refreshToken)) {
      return { status: 'reused', config: cleared }
    }
    if (cleared?.refreshToken === refreshToken) {
      return {
        status: 'unavailable',
        config: cleared,
        error: new Error('Failed to clear invalid sync credentials')
      }
    }
    return { status: 'invalid', config: cleared || current || latest }
  }

  return persistRefreshedCredentials(refreshToken, tokens)
}

/**
 * 仅在 refresh token 仍与失败请求一致时清理凭据，防止误清新登录账号。
 * @param expectedRefreshToken 已被服务端确认失效的 refresh token。
 * @returns 清理后的配置；存储已变化或读取失败时返回当前配置或 null。
 */
export async function clearInvalidStoredCredentials(
  expectedRefreshToken: string
): Promise<StoredSyncConfig | null> {
  return clearStoredCredentialsIfCurrent(expectedRefreshToken)
}

/**
 * 清理服务端已拒绝且没有 refresh token 可恢复的旧访问令牌。
 * @param expectedAccessToken 已被服务端拒绝的访问令牌。
 * @returns 清理后的配置；存储已变化或读取失败时返回当前配置或 null。
 */
export async function clearInvalidStoredAccessToken(
  expectedAccessToken: string
): Promise<StoredSyncConfig | null> {
  return clearStoredCredentialsIfCurrent('', expectedAccessToken)
}

/**
 * 仅在 token 仍与失败请求快照一致时清理本地凭据，并处理配置 revision 冲突。
 * @param expectedRefreshToken 期望仍在存储中的 refresh token；无 refresh token 时传空串。
 * @param expectedAccessToken 可选的访问令牌快照，用于保护无 refresh token 的旧配置。
 * @returns 清理后的配置；凭据已变化或重试耗尽时返回当前配置或 null。
 */
async function clearStoredCredentialsIfCurrent(
  expectedRefreshToken: string,
  expectedAccessToken?: string
): Promise<StoredSyncConfig | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const store = await getSyncConfigStore()
    const currentDoc = await store.promises.get('SYNC/config')
    const current = (currentDoc?.data as StoredSyncConfig | undefined) || null
    if (
      !current ||
      (current.refreshToken || '') !== expectedRefreshToken ||
      (expectedAccessToken !== undefined && current.token !== expectedAccessToken)
    ) {
      return current
    }

    const cleared: StoredSyncConfig = {
      ...current,
      token: '',
      refreshToken: ''
    }
    const result = await store.promises.put({
      _id: 'SYNC/config',
      _rev: currentDoc?._rev,
      data: cleared
    })
    if (result?.ok) {
      // 凭据落盘后再通知消费者，确保界面重读时不会看到旧头像登录态。
      notifyCredentialsInvalidated(cleared)
      return cleared
    }
    if (result?.name !== 'conflict') {
      throw new Error(result?.message || 'Failed to clear invalid sync credentials')
    }
  }
  return loadStoredSyncConfig()
}

/**
 * 在 refresh token 未变化的前提下持久化换发结果，并在配置 revision 冲突时重试。
 * @param expectedRefreshToken 本轮已经被服务端消费的 refresh token。
 * @param tokens 服务端换发的新 token 对。
 * @returns 刷新成功、复用其他写入结果或暂时不可用的结构化结果。
 */
async function persistRefreshedCredentials(
  expectedRefreshToken: string,
  tokens: { token: string; refreshToken: string }
): Promise<StoredTokenRefreshResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 每次写入前重读 revision，同时保留其他模块刚写入的配置字段。
    const store = await getSyncConfigStore()
    const currentDoc = await store.promises.get('SYNC/config')
    const current = (currentDoc?.data as StoredSyncConfig | undefined) || null
    if (!current || current.refreshToken !== expectedRefreshToken) {
      return current
        ? { status: 'reused', config: current }
        : { status: 'unavailable', config: null }
    }

    const nextConfig: StoredSyncConfig = {
      ...current,
      token: tokens.token,
      refreshToken: tokens.refreshToken
    }
    const result = await store.promises.put({
      _id: 'SYNC/config',
      _rev: currentDoc?._rev,
      data: nextConfig
    })
    if (result?.ok) return { status: 'refreshed', config: nextConfig }
    if (result?.name !== 'conflict') {
      return {
        status: 'unavailable',
        config: current,
        error: new Error(result?.message || 'Failed to persist refreshed sync credentials')
      }
    }
  }
  return { status: 'unavailable', config: await loadStoredSyncConfig() }
}

/**
 * 隔离执行所有凭据失效监听器，避免单个消费者阻断其他状态更新。
 * @param config 已清空 token 的同步配置。
 * @returns 无返回值。
 */
function notifyCredentialsInvalidated(config: StoredSyncConfig): void {
  for (const listener of credentialsInvalidatedListeners) {
    try {
      listener(config)
    } catch (error) {
      console.error('[SyncAuth] 凭据失效监听器执行失败:', error)
    }
  }
}

/**
 * 按需加载设备级路由存储，避免仅导入同步客户端时提前绑定 Electron 生命周期。
 * @returns 可读写 `SYNC/config` 的路由存储实例。
 */
async function getSyncConfigStore(): Promise<SyncConfigStore> {
  if (!syncConfigStorePromise) {
    syncConfigStorePromise = import('../lmdb/lmdbInstance').then(
      (module) => module.default as unknown as SyncConfigStore
    )
  }
  return syncConfigStorePromise
}

/**
 * 将 WebSocket 服务地址转换为对应的 HTTP API 地址。
 * @param serverUrl WebSocket 服务地址。
 * @returns HTTP 或 HTTPS 服务地址。
 */
function syncServerUrlToHttp(serverUrl: string): string {
  return serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
}

/**
 * 安全解析刷新接口返回的 JSON 字符串。
 * @param value 待解析的字符串。
 * @returns 解析结果；格式错误时返回空对象。
 */
function safeParseJSON(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
