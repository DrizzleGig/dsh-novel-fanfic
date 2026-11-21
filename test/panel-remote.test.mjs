// 0.2.3 回归：面板读取不再执行 /fic 命令。
//
// 现象（2026-11-21）：打开或刷新右栏「同人」面板会执行 /fic panel --json 等命令，
// DSH 的 commands.execute() 每次都会往会话日志追加 command/run + command/done，
// 于是对话里多出一行「fic」命令卡；实测一个会话 51 次。
//
// 修法：Host 提供 novelFanficPanelView（与 /fic 命令共用同一个 handler），
// panel remote 调它，不经过命令通道。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { DESCRIPTORS, TYPERT_REMOTE } from '../lib/remote-contract.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function host() {
  const services = new Map()
  const commands = []
  const tools = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    commands: {
      register(definition) { commands.push(definition); return () => {} },
      // 刻意不提供 execute：任何读操作若退回命令通道会当场炸。
    },
    provide(key, value) { services.set(key, value) },
    get(key) { return services.get(key) },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, services, commands, tools }
}

test('Host 提供 novelFanficPanelView，与 /fic 共用 handler，且不需要命令通道', async () => {
  const { ctx, services, commands } = host()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fanfic-panel-'))
  apply(ctx, { root: dir, stateDir: dir })

  assert.equal(commands.filter((entry) => entry.name === 'fic').length, 1, '/fic 仍注册一次')
  const view = services.get('novelFanficPanelView')
  assert.ok(view, '要提供 novelFanficPanelView')
  assert.equal(view.apiVersion, 1)
  assert.equal(typeof view.dispatch, 'function')

  const agent = { id: 'session-panel', session: { id: 'session-panel' } }
  const result = await view.dispatch(agent, 'status --json')
  assert.equal(result.kind, 'success')
  const snapshot = JSON.parse(result.text)
  assert.ok(snapshot && typeof snapshot === 'object')
})

test('remote 契约：12 个方法、namespace/service 固定，客户端内嵌协议与 Host 一致', () => {
  const methods = DESCRIPTORS.map((descriptor) => descriptor.method).sort()
  assert.deepEqual(methods, [
    'checkDraft', 'getChapter', 'getContract', 'getDeltas', 'getPanel', 'getPlan', 'identity',
    'listImportFiles', 'listProjects', 'pickDirectory', 'previewImport', 'search',
  ])
  for (const descriptor of DESCRIPTORS) {
    assert.equal(descriptor.namespace, 'novelFanficPanel')
    assert.equal(descriptor.service, 'novelFanficPanel')
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.ok(descriptor.parameters.some((parameter) => parameter.name === 'sessionId'))
  }
  assert.equal(TYPERT_REMOTE.package, 'dsh-novel-fanfic')

  // 客户端是浏览器脚本，协议内嵌一份；这里核对两侧方法集合没有漂移。
  const client = readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  for (const method of methods) {
    assert.ok(
      client.includes(`novelFanficPanel/${method}`) || client.includes(`'${method}'`),
      `client.js 的协议里缺少 ${method}`,
    )
  }
})

test('0.2.3 源码守卫：客户端读适配器不再拼 /fic 读命令', () => {
  const client = readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  for (const line of ['/fic panel --json', '/fic projects --json', '/fic chapter ', '/fic contract ', '/fic search ', '/fic preview ', '/fic pickdir', '/fic files ', '/fic check ']) {
    assert.ok(!client.includes(line), `客户端读路径不应再出现 ${line}`)
  }
  assert.ok(client.includes('callRemote('), '读操作应走 panel remote')
})
