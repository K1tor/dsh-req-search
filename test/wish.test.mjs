/**
 * Tests for wish detection: deciding from the message text alone whether a
 * turn states a requirement worth researching.
 */
import assert from 'node:assert/strict'
import { isRequirementMessage, messageText, pickRequirement } from '../lib/wish.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

/** Build a claimed user message. */
function message(text) {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

test('messageText reads the text blocks of a message', () => {
  assert.equal(messageText(message('hello')), 'hello')
  assert.equal(messageText({ content: 'plain string' }), 'plain string')
  assert.equal(messageText({ content: [{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(messageText(undefined), '')
  assert.equal(messageText({}), '')
})

test('an explicit wish is a requirement', () => {
  assert.equal(isRequirementMessage(message('我需要你做一个模拟经营游戏')), true)
  assert.equal(isRequirementMessage(message('我想做一个 Steam 创意工坊式的模组加载器')), true)
  assert.equal(isRequirementMessage(message('I want to build a management simulation game')), true)
  assert.equal(isRequirementMessage(message('帮我做一个后台管理系统')), true)
  assert.equal(isRequirementMessage(message('Can you build a REST API service with auth')), true)
})

test('a build verb with a product word is a requirement', () => {
  assert.equal(isRequirementMessage(message('创建一个用于下载视频的命令行工具')), true)
  assert.equal(isRequirementMessage(message('实现一个前端仪表盘组件库')), true)
  assert.equal(isRequirementMessage(message('Write a desktop app for tag management')), true)
})

test('ordinary chat is not a requirement', () => {
  assert.equal(isRequirementMessage(message('谢谢你，已经完成了')), false)
  assert.equal(isRequirementMessage(message('好的')), false)
  assert.equal(isRequirementMessage(message('继续')), false)
  assert.equal(isRequirementMessage(message('go on')), false)
  assert.equal(isRequirementMessage(message('这个报错是什么原因？')), false)
  assert.equal(isRequirementMessage(message('What does this function do?')), false)
})

test('a bare question is not a requirement', () => {
  assert.equal(isRequirementMessage(message('数据库应该用哪个？')), false)
  assert.equal(isRequirementMessage(message('how do I deploy this?')), false)
})

test('a very short or very long message is not a requirement', () => {
  assert.equal(isRequirementMessage(message('做')), false)
  assert.equal(isRequirementMessage(message('x'.repeat(3000))), false)
})

test('a follow-up instruction is not a new requirement', () => {
  assert.equal(isRequirementMessage(message('改一下那个按钮的颜色就行')), false)
  assert.equal(isRequirementMessage(message('加上分页')), false)
})

test('pickRequirement takes the last requirement among the claimed', () => {
  const messages = [message('我需要你做一个模拟经营游戏'), message('再加一个存档系统')]
  // The follow-up alone is not a requirement, so the original wish is picked.
  assert.equal(pickRequirement(messages), '我需要你做一个模拟经营游戏')
})

test('pickRequirement prefers a later requirement when there is one', () => {
  const messages = [message('我需要你做一个模拟经营游戏'), message('我还想做一个塔防游戏')]
  assert.equal(pickRequirement(messages), '我还想做一个塔防游戏')
})

test('pickRequirement returns nothing when no message is a requirement', () => {
  assert.equal(pickRequirement([message('好的')]), '')
  assert.equal(pickRequirement([]), '')
  assert.equal(pickRequirement(undefined), '')
})

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
if (failed > 0) process.exitCode = 1
