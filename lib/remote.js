/**
 * Host half of the fanfic sidebar panel reads.
 *
 * The sidebar used to call `/fic panel --json` through `commands.execute()`.
 * DSH logs every executed command as `command/run` + `command/done`, so opening
 * or refreshing the panel wrote rows into the conversation transcript. This
 * remote calls the plugin's own handler in-process (`novelFanficPanelView`),
 * which shares one implementation with the CLI and produces no session events.
 *
 * The class is written with explicit decorator application instead of decorator
 * syntax, so this file stays plain ESM like the rest of the package.
 */

import { readFileSync } from 'node:fs'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DESCRIPTORS } from './remote-contract.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** Marker initializers collected by the explicit decorator pass below. */
const initializers = []

function markRemote(proto, name) {
  const context = {
    kind: 'method',
    name,
    static: false,
    private: false,
    addInitializer(fn) {
      initializers.push(fn)
    },
  }
  Remote(name)(proto[name], context)
}

class FanficPanelRemote extends TypertRemoteService {
  static inject = ['agents', 'typert']

  constructor(ctx) {
    super(ctx, 'novelFanficPanel')
    for (const initializer of initializers) initializer.call(this)
    ctx.typert.register({
      package: 'dsh-novel-fanfic',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: DESCRIPTORS,
    })
  }

  agent(id) {
    const agent = this.ctx.agents.get(SessionId(id))
    if (!agent) throw new Error('会话尚未加载或已关闭，请重新打开会话后重试。')
    return agent
  }

  view() {
    const view = this.ctx.get('novelFanficPanelView')
    if (!view || typeof view.dispatch !== 'function') {
      throw new Error('面板读接口未就绪：请更新并重载 DSH（0.2.3 起面板读取走 remote）。')
    }
    return view
  }

  async call(id, line) {
    return await this.view().dispatch(this.agent(id), line)
  }

  async text(id, line) {
    const result = await this.call(id, line)
    if (!result || result.kind !== 'success') throw new Error(result?.text || '读取失败')
    return result.text
  }

  async json(id, line) {
    return JSON.parse(await this.text(id, line))
  }

  project(request) {
    const project = request?.project
    if (project === undefined || project === null || project === '') return ''
    if (typeof project !== 'string' || project.length > 200 || /[\\/\u0000]/.test(project)) {
      throw new Error('project 必须是单个项目目录名')
    }
    return ` --project ${project}`
  }

  async identity(sessionId) {
    this.agent(sessionId)
    return { plugin: 'dsh-novel-fanfic', version: VERSION, apiVersion: 1 }
  }

  async getPanel(sessionId, request = {}) {
    return await this.json(sessionId, `panel --json${this.project(request)}`)
  }

  async listProjects(sessionId, request = {}) {
    return await this.json(sessionId, `projects --json${this.project(request)}`)
  }

  async getChapter(sessionId, request = {}) {
    const chapter = String(request.chapter || '')
    if (!chapter) throw new Error('chapter 必填')
    return await this.json(sessionId, `chapter ${chapter} --json${this.project(request)}`)
  }

  async getContract(sessionId, request = {}) {
    const chapter = String(request.chapter || '')
    if (!chapter) throw new Error('chapter 必填')
    const source = request.source === 'fixture' || request.source === 'canon' ? ` --source ${request.source}` : ''
    return await this.json(sessionId, `contract ${chapter} --json${source}${this.project(request)}`)
  }

  async getPlan(sessionId, request = {}) {
    const chapter = String(request.chapter || '')
    if (!chapter) throw new Error('chapter 必填')
    return await this.json(sessionId, `plan get ${chapter} --json${this.project(request)}`)
  }

  async search(sessionId, request = {}) {
    const term = String(request.term || '').trim()
    if (!term) throw new Error('term 必填')
    const limit = Math.max(1, Math.min(100, Number(request.limit) || 20))
    return await this.json(sessionId, `search ${term} --json --limit ${limit}${this.project(request)}`)
  }

  async previewImport(sessionId, request = {}) {
    const file = String(request.file || '')
    if (!file) throw new Error('file 必填')
    return await this.json(sessionId, `preview ${file} --json${this.project(request)}`)
  }

  async listImportFiles(sessionId, request = {}) {
    const dir = String(request.dir || '')
    if (!dir) throw new Error('dir 必填')
    return await this.json(sessionId, `files ${dir} --json`)
  }

  async checkDraft(sessionId, request = {}) {
    const chapter = String(request.chapter || '')
    if (!chapter) throw new Error('chapter 必填')
    if (typeof request.text !== 'string') throw new Error('text 必填')
    return await this.json(
      sessionId,
      `check ${chapter} --json --text ${encodeURIComponent(request.text)}${this.project(request)}`,
    )
  }

  async pickDirectory(sessionId) {
    const result = await this.call(sessionId, 'pickdir --json')
    const text = String(result?.text ?? '')
    try {
      return JSON.parse(text)
    } catch {
      if (result?.kind === 'success') return { ok: false, error: text }
      throw new Error(text || '目录选择失败')
    }
  }

  async getDeltas(sessionId, request = {}) {
    return await this.json(sessionId, `delta list --json${this.project(request)}`)
  }

  async getAvatar(sessionId, request = {}) {
    const view = this.view()
    if (typeof view.getAvatar !== 'function') throw new Error('面板头像接口未就绪：请更新并重载 DSH（0.4.0 起）。')
    return await view.getAvatar(this.agent(sessionId), request)
  }

  async avatar(sessionId, request = {}) {
    const view = this.view()
    if (typeof view.avatar !== 'function') throw new Error('面板头像写入接口未就绪：请更新并重载 DSH（0.4.0 起）。')
    return await view.avatar(this.agent(sessionId), request)
  }

  async media(sessionId, request = {}) {
    const view = this.view()
    if (typeof view.media !== 'function') throw new Error('面板媒体接口未就绪：请更新并重载 DSH（0.4.1 起）。')
    return await view.media(this.agent(sessionId), request)
  }

  async analysis(sessionId, request = {}) {
    const view = this.view()
    if (typeof view.analysis !== 'function') throw new Error('面板分析接口未就绪：请更新并重载 DSH（0.4.2 起）。')
    return await view.analysis(this.agent(sessionId), request)
  }
}

// Apply the Remote marker to exactly the methods the contract exposes.
for (const name of Object.getOwnPropertyNames(FanficPanelRemote.prototype)) {
  if (name === 'constructor') continue
  if (!DESCRIPTORS.some((descriptor) => descriptor.method === name)) continue
  markRemote(FanficPanelRemote.prototype, name)
}

export default FanficPanelRemote
