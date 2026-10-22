/**
 * Compile-free tool declarations for the host half.
 *
 * `defineTool` from `@deepseek-ai/dsh-tools` is the normal way to declare a
 * tool, but importing it forces the package to be present in the host's
 * resolution set. This plugin is also installed through `link:` into profiles
 * whose `node_modules` do not carry the harness packages, so the declarations
 * here are plain objects that satisfy the same registry contract:
 * `{ name, description, parameters (JSON Schema), output: { schema, render },
 *    timeoutMs?, isConcurrencySafe?, execute(args, exec) }`.
 *
 * The registry validates `exec.output.schema` with the same supported subset it
 * validates `defineTool` output with, so a schema mistake fails loudly at
 * registration exactly as it would with `defineTool`.
 */

/**
 * Build one registry-ready tool definition without importing the tool package.
 *
 * @param {object} spec - the tool definition (same shape `defineTool` accepts).
 * @returns {object} a tool definition for `ctx.tools.register`.
 */
export function tool(spec) {
  if (typeof spec.name !== 'string' || spec.name.length === 0) throw new Error('tool: name must be a non-empty string')
  if (typeof spec.description !== 'string' || spec.description.length === 0) throw new Error(`tool(${spec.name}): description must be a non-empty string`)
  if (spec.output === undefined || typeof spec.output.render !== 'function') throw new Error(`tool(${spec.name}): output.render must be a function`)

  const { parameters = {}, output, execute, ...rest } = spec
  if (typeof execute !== 'function') throw new Error(`tool(${spec.name}): execute must be a function`)

  const compiled = compileParameters(parameters)
  return {
    name: spec.name,
    description: spec.description,
    parameters: compiled.schema,
    output: {
      schema: output.schema,
      render: output.render,
      ...(output.presentationMeta === undefined ? {} : { presentationMeta: output.presentationMeta }),
    },
    ...(rest.timeoutMs === undefined ? {} : { timeoutMs: rest.timeoutMs }),
    ...(rest.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: rest.isConcurrencySafe }),
    ...(rest.deferLoading === undefined ? {} : { deferLoading: rest.deferLoading }),
    async execute(args, exec) {
      const violations = validateAgainst(compiled.schema, args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return execute(args, exec)
    },
  }
}

/**
 * Compile an author-facing parameter map (property name → schema spec with an
 * optional `required` flag) into an object JSON Schema.
 *
 * @param {Record<string, object>} parameters - the author's parameter map.
 * @returns {{ schema: object }} the compiled root schema.
 */
export function compileParameters(parameters) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = spec
    properties[name] = rest
    if (isRequired === true) required.push(name)
  }
  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length === 0 ? {} : { required }),
    },
  }
}

/**
 * Validate a value against the schema subset the registry enforces.
 *
 * Only the keywords these tools use are checked: `type`, `required`,
 * `properties`, `items`, `enum`, `const`, `oneOf`. That keeps a bad argument
 * from reaching `execute` without pulling in a schema library.
 *
 * @param {object} schema - the compiled schema.
 * @param {unknown} value - the candidate value.
 * @param {string} [path] - diagnostic path.
 * @returns {string[]} violations, empty when valid.
 */
export function validateAgainst(schema, value, path = 'arguments') {
  const violations = []
  if (schema === undefined) return violations

  if (Array.isArray(schema.oneOf)) {
    if (!schema.oneOf.some((branch) => validateAgainst(branch, value, path).length === 0)) {
      violations.push(`${path} does not match any allowed shape`)
    }
    return violations
  }

  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    violations.push(`${path} must be ${JSON.stringify(schema.const)}`)
    return violations
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
    return violations
  }

  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        violations.push(`${path} must be an object`)
        return violations
      }
      const properties = schema.properties ?? {}
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`)
      }
      for (const [key, property] of Object.entries(properties)) {
        if (Object.hasOwn(value, key)) violations.push(...validateAgainst(property, value[key], `${path}.${key}`))
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path} must be an array`)
        return violations
      }
      if (schema.items !== undefined) {
        value.forEach((entry, index) => violations.push(...validateAgainst(schema.items, entry, `${path}[${index}]`)))
      }
      return violations
    }
    case 'string':
      if (typeof value !== 'string') violations.push(`${path} must be a string`)
      return violations
    case 'integer':
      if (!Number.isInteger(value)) violations.push(`${path} must be an integer`)
      return violations
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path} must be a number`)
      return violations
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
      return violations
    case 'null':
      if (value !== null) violations.push(`${path} must be null`)
      return violations
    default:
      return violations
  }
}
