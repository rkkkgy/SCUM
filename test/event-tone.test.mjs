import test from 'node:test';
import assert from 'node:assert/strict';
import { eventTone } from '../public/event-tone.js';

test('事件颜色：上线绿、下线红、开锁成功绿、开锁失败红', () => {
  assert.equal(eventTone({ category: 'online', type: 'online' }), 'good');
  assert.equal(eventTone({ category: 'online', type: 'offline' }), 'bad');
  assert.equal(eventTone({ category: 'online', type: 'new' }), 'info');
  assert.equal(eventTone({ category: 'unlock', type: 'unlock' }), 'good');
  assert.equal(eventTone({ category: 'unlock', type: 'unlock_fail' }), 'bad');
});

test('事件颜色：击杀/榜单/风控/系统', () => {
  assert.equal(eventTone({ category: 'kill', type: 'kill' }), 'bad');
  assert.equal(eventTone({ category: 'rank', type: 'rank_up' }), 'good');
  assert.equal(eventTone({ category: 'rank', type: 'rank_enter' }), 'good');
  assert.equal(eventTone({ category: 'rank', type: 'rank_down' }), 'bad');
  assert.equal(eventTone({ category: 'risk', type: 'risk_add' }), 'bad');
  assert.equal(eventTone({ category: 'risk', type: 'risk_remove' }), 'good');
  assert.equal(eventTone({ category: 'system', type: 'restart' }), 'warn');
  assert.equal(eventTone({ category: 'system', type: 'source_ready' }), 'info');
  assert.equal(eventTone({ category: 'unknown', type: 'x' }), 'muted');
});

test('事件颜色：缺字段时按在线事件兜底，不抛错', () => {
  assert.equal(eventTone({}), 'good');
  assert.equal(eventTone(undefined), 'good');
  assert.equal(eventTone({ category: 'online' }), 'good');
});
