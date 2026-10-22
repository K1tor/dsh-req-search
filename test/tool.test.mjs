/**
 * Tool-declaration tests: the local `tool()` helper has to meet the registry
 * contract without importing the harness tool package, and the definitions this
 * plugin registers have to satisfy the registry's strict schema subset.
 */
import assert from 'node:assert/strict'
import { compileParameters, tool, validateAgainst } from '../lib/tool.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

/** A minimal valid definition. */
function definition(overrides = {}) {
  return {
    name: 'demo',
    description: 'A demo tool.',
    parameters: { value: { type: 'string', required: true, description: 'A value.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args) => args.value,
    ...overrides,
  }
}

/** Mount the host half with a tool registry only. */
async function registeredTools() {
  const { apply } = await import('../lib/host.js')
  const tools = new Map()
  apply({
    get: () => undefined,
    on: () => () => {},
    inject: (services, callback) => {
      if (services[0] === 'tools') callback({ tools: { register: (entry) => { tools.set(entry.name, entry); return () => {} } } })
    },
  }, {})
  return tools
}

// ── the local helper ────────────────────────────────────────────────────────

test('compileParameters splits required flags out of the property specs', () => {
  const { schema } = compileParameters({
    a: { type: 'string', required: true, description: 'A' },
    b: { type: 'integer' },
  })
  assert.deepEqual(schema.required, ['a'])
  assert.equal(schema.properties.a.type, 'string')
  assert.equal(schema.properties.a.required, undefined)
})

test('compileParameters omits required when nothing is required', () => {
  const { schema } = compileParameters({ a: { type: 'string' } })
  assert.equal(Object.hasOwn(schema, 'required'), false)
})

test('tool() builds a registry-shaped definition', () => {
  const built = tool(definition())
  assert.equal(built.name, 'demo')
  assert.equal(built.parameters.type, 'object')
  assert.equal(typeof built.output.render, 'function')
  assert.equal(typeof built.execute, 'function')
})

test('tool() rejects incomplete definitions', () => {
  assert.throws(() => tool(definition({ name: '' })), /name/u)
  assert.throws(() => tool(definition({ description: '' })), /description/u)
  assert.throws(() => tool(definition({ output: undefined })), /output\.render/u)
  assert.throws(() => tool(definition({ execute: undefined })), /execute/u)
})

test('the compiled execute validates arguments before running', async () => {
  const built = tool(definition())
  assert.equal(await built.execute({ value: 'ok' }, {}), 'ok')
  await assert.rejects(() => built.execute({}, {}), /invalid arguments: arguments\.value is required/u)
  await assert.rejects(() => built.execute({ value: 7 }, {}), /must be a string/u)
})

test('validateAgainst covers the enforced subset', () => {
  const schema = {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'array', items: { type: 'integer' } },
      mode: { type: 'string', enum: ['a', 'b'] },
      exact: { const: 3 },
      flag: { type: 'boolean' },
      ratio: { type: 'number' },
      nested: { type: 'object', properties: { inner: { type: 'string' } } },
      either: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    },
  }
  assert.deepEqual(validateAgainst(schema, { list: [1, 2], mode: 'a', exact: 3, flag: true, ratio: 1.5, nested: { inner: 'x' }, either: null }), [])
  assert.ok(validateAgainst(schema, { list: [1, 'x'] }).some((violation) => /list\[1\] must be an integer/u.test(violation)))
  assert.ok(validateAgainst(schema, { list: [], mode: 'c' }).some((violation) => /must be one of/u.test(violation)))
  assert.ok(validateAgainst(schema, { list: [], exact: 4 }).some((violation) => /must be 3/u.test(violation)))
  assert.ok(validateAgainst(schema, { list: [], nested: 3 }).some((violation) => /nested must be an object/u.test(violation)))
  assert.ok(validateAgainst(schema, { list: [], either: 5 }).some((violation) => /does not match any allowed shape/u.test(violation)))
  assert.ok(validateAgainst(schema, { list: 'no' }).some((violation) => /list must be an array/u.test(violation)))
})

test('untyped schemas accept any value', () => {
  assert.deepEqual(validateAgainst({}, { anything: true }), [])
  assert.deepEqual(validateAgainst({ description: 'no type' }, 42), [])
})

// ── the registry's raw-schema subset ────────────────────────────────────────
//
// `ctx.tools.register` runs `assertSupportedJsonSchema` over a definition's
// output schema. The author-facing DSL (defineTool) accepts `required: true` on
// a property and rewrites it; a hand-built definition does not go through that
// rewrite, so these cases check the raw shape instead of trusting the author
// form. Mirrored from the registry's own keyword sets.

const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * Mirror the registry's subset check.
 * @param {unknown} schema - candidate schema.
 * @param {string} [path] - diagnostic path.
 * @returns {string[]} violations.
 */
function checkSubset(schema, path = 'schema') {
  const violations = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [`${path} must be a schema object`]
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) violations.push(`${path}.${key} is not a supported keyword`)
  }
  if (schema.type === undefined && schema.oneOf === undefined) return violations
  if (schema.type !== undefined && schema.oneOf !== undefined) violations.push(`${path} cannot declare both type and oneOf`)
  if (!SCHEMA_TYPES.has(schema.type)) violations.push(`${path}.type is not a supported type`)
  if (schema.type === 'object') {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(properties, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
    }
    for (const [key, child] of Object.entries(properties)) violations.push(...checkSubset(child, `${path}.properties.${key}`))
  }
  if (schema.type === 'array' && schema.items !== undefined) violations.push(...checkSubset(schema.items, `${path}.items`))
  if (Array.isArray(schema.oneOf)) {
    for (const [index, branch] of schema.oneOf.entries()) violations.push(...checkSubset(branch, `${path}.oneOf[${index}]`))
  }
  return violations
}

test('registered tool schemas satisfy the registry subset', async () => {
  const tools = await registeredTools()
  // `recall_project` is registered here too: it used to be gated on a second
  // `ctx.get('tools')` probe, which a host that does inject the registry never
  // needs — and which left the tool missing on exactly the hosts that had it.
  assert.deepEqual([...tools.keys()].sort(), ['ask_style', 'recall_project', 'research_requirement', 'vet_dependency'])
  for (const [name, entry] of tools) {
    const parameters = {
      type: 'object',
      additionalProperties: false,
      properties: entry.parameters.properties,
      ...(entry.parameters.required === undefined ? {} : { required: entry.parameters.required }),
    }
    assert.deepEqual(checkSubset(parameters, `${name}.parameters`), [], `${name} parameters`)
    assert.deepEqual(checkSubset(entry.output.schema, `${name}.output.schema`), [], `${name} output schema`)
  }
})

test('no registered schema carries a property-level required flag', async () => {
  const tools = await registeredTools()
  for (const [name, entry] of tools) {
    assert.equal(JSON.stringify(entry.output.schema).includes('"required":true'), false, `${name} output schema`)
    assert.equal(JSON.stringify(entry.parameters).includes('"required":true'), false, `${name} parameters`)
  }
})

let failed = 0
for (const [caseName, run] of cases) {
  try {
    await run()
    console.log(`ok   ${caseName}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${caseName}\n     ${error.message}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
if (failed > 0) process.exitCode = 1
