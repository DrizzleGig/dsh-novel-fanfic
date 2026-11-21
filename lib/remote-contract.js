/**
 * Typert remote contract for the fanfic-sidebar panel reads.
 *
 * Why this exists: the sidebar used to fetch its data by executing `/fic panel --json`
 * through `commands.execute()`. DSH logs every executed command as `command/run` +
 * `command/done`, so opening or refreshing the panel wrote rows into the conversation
 * transcript. This remote calls the plugin's own read path in-process instead — no
 * command, no session events.
 *
 * Keep this file dependency-free: the registry only needs a codec whose create()
 * returns a schema with parse().
 */

function scalar(validate) {
  return {
    parse(value) {
      validate(value)
      return value
    },
    safeParse(value) {
      try {
        validate(value)
        return { success: true, data: value }
      } catch (error) {
        return { success: false, error }
      }
    },
  }
}

const sessionIdSchema = scalar((value) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('sessionId must be a non-empty string')
  }
})

/** Panel requests are plain objects; each Host handler validates its own fields. */
const requestSchema = scalar((value) => {
  if (value === undefined || value === null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request must be a plain object')
  }
})

const payloadSchema = scalar(() => {})

function strictCodec(typeSymbol, schema) {
  return { mode: 'strict', typeSymbol, create: () => schema }
}

function parameter(name, schema) {
  return { name, wire: name, source: 'json', codec: strictCodec(name, schema) }
}

const methods = [
  'identity',
  'getPanel',
  'listProjects',
  'getChapter',
  'getContract',
  'getPlan',
  'search',
  'previewImport',
  'listImportFiles',
  'checkDraft',
  'pickDirectory',
  'getDeltas',
]

export const DESCRIPTORS = methods.map((method) => ({
  id: `dsh-novel-fanfic#novelFanficPanel/${method}`,
  namespace: 'novelFanficPanel',
  service: 'novelFanficPanel',
  method,
  invocation: { kind: 'direct' },
  parameters: method === 'identity'
    ? [parameter('sessionId', sessionIdSchema)]
    : [parameter('sessionId', sessionIdSchema), parameter('request', requestSchema)],
  result: strictCodec('FanficPanelPayload', payloadSchema),
}))

export const TYPERT_REMOTE = { package: 'dsh-novel-fanfic', descriptors: DESCRIPTORS }
