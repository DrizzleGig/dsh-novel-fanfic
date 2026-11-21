// 工具参数 schema 的守卫：把「宿主会拒绝的形状」挡在发布之前。
//
// 背景（2026-11-21）：fanfic 0.2.0 把插件内部的「参数名 → 描述对象」表直接交给
// `ctx.tools.register()`。这版 DSH 的 register() 收的是**编译好的 JSON Schema**
// （简写只对 `defineTool()` 生效），宿主不校验就透传给模型接口，接口按 schema 解析根级键；
// `fic_plan` 的参数名 `title` 正好是 JSON Schema 的注解关键字（值必须是字符串），
// 于是每条消息都 400，且 /fic on 会持久化到 prefs.json，重启后每个新会话都中招。
//
// 这里不依赖 DSH 内部包，按宿主支持的子集（type/oneOf/properties/required/
// additionalProperties/items/enum/const + 注解）检查参数根与每个属性。

const ALLOWED_ROOT_KEYS = new Set(['type', 'properties', 'required']);
const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples', 'enum', 'const', 'deprecated']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 断言一份工具参数是宿主可接受的 JSON Schema。
 * @param {string} toolName 工具名，只用来把错误信息指到具体工具。
 * @param {unknown} parameters 注册给 ctx.tools.register() 的 parameters。
 */
export function assertParameterSchema(toolName, parameters) {
  const fail = (message) => {
    throw new Error(`工具 ${toolName} 的 parameters 不是宿主接受的 JSON Schema：${message}`);
  };
  if (!isPlainObject(parameters)) fail('根必须是对象');
  for (const key of Object.keys(parameters)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      fail(
        `根级出现 "${key}"。参数名要放进 properties，根级只允许 type / properties / required；`
        + '整张参数表直接交给宿主正是 0.2.0 的 400 根因。',
      );
    }
  }
  if (parameters.type !== 'object') fail('根级 type 必须是 "object"');
  if (!isPlainObject(parameters.properties)) fail('properties 必须是对象');

  for (const [name, schema] of Object.entries(parameters.properties)) {
    if (!isPlainObject(schema)) fail(`参数 ${name} 的 schema 必须是对象`);
    if (Object.hasOwn(schema, 'required')) {
      fail(`参数 ${name} 的 schema 里出现 required（required 是参数名数组，属于根级）`);
    }
    const hasOneOf = Array.isArray(schema.oneOf);
    if (!hasOneOf && typeof schema.type !== 'string') fail(`参数 ${name} 缺少 type`);
    if (!hasOneOf && !ALLOWED_TYPES.has(schema.type)) fail(`参数 ${name} 的 type "${schema.type}" 不在支持列表`);
    if (schema.type === 'array') {
      if (!isPlainObject(schema.items) && typeof schema.items !== 'boolean') {
        fail(`参数 ${name} 是数组，但缺少 items`);
      }
      if (isPlainObject(schema.items) && typeof schema.items.type !== 'string' && !Array.isArray(schema.items.oneOf)) {
        fail(`参数 ${name}.items 缺少 type`);
      }
    }
    for (const key of Object.keys(schema)) {
      if (key === 'required') continue;
      if (['type', 'items', 'properties', 'additionalProperties', 'oneOf', 'required'].includes(key)) continue;
      if (ANNOTATION_KEYS.has(key)) continue;
      fail(`参数 ${name} 里有不支持的键 "${key}"`);
    }
  }

  if (Object.hasOwn(parameters, 'required')) {
    if (!Array.isArray(parameters.required)) fail('根级 required 必须是数组');
    for (const name of parameters.required) {
      if (typeof name !== 'string') fail(`required 里出现非字符串：${JSON.stringify(name)}`);
      if (!Object.hasOwn(parameters.properties, name)) fail(`required 里的 "${name}" 不在 properties 中`);
    }
  }
}

/**
 * 用假的 ctx 调一次插件 apply()，把注册的工具定义抓出来。
 * 覆盖各插件用到的 ctx 面（tools/commands/provide/effect/on/get/logger）。
 * @param {(ctx: object, config?: object) => void} applyFn 插件的 apply。
 * @param {object} config 传给 apply 的配置。
 */
export function captureToolDefinitions(applyFn, config = {}) {
  const definitions = [];
  const noop = () => {};
  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition);
        return noop;
      },
    },
    commands: { register: () => noop },
    provide: noop,
    effect: (fn) => {
      const result = typeof fn === 'function' ? fn() : undefined;
      return typeof result === 'function' ? result : noop;
    },
    on: () => noop,
    get: () => undefined,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  };
  applyFn(ctx, config);
  return definitions;
}
