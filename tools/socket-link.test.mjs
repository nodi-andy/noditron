import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createSocketLinks, socketLineOf, socketPortsOf } from '../client/src/socketLink.js';

// A board's `socket` port is its shell as a wire (see socketLink.js):
// out carries what the board prints, in writes what arrives to the shell.

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('both board modules carry a socket port, the S3 out and the CNC in', () => {
  const s3 = JSON.parse(read('../modules/esp32-s3-devkit/noditron.module.json')).block.blocks[0];
  const cnc = JSON.parse(read('../modules/esp32-cnc/noditron.module.json')).block.blocks[0];
  assert.deepEqual(socketPortsOf(s3).map((s) => s.direction), ['out']);
  assert.deepEqual(socketPortsOf(cnc).map((s) => s.direction), ['in']);
  assert.ok(!cnc.logicalPorts.some((lp) => lp.name === 'gcode'), 'the gcode input is gone');
  // The socket is not a GPIO: the board's own circuit compiler skips it.
  const pin = JSON.parse(s3.props.find((p) => p.name === 'pinMap').value).find((p) => p.role === 'socket');
  assert.equal(pin.gpio, null);
});

test('only the board\'s own socket announcements are the socket\'s', () => {
  assert.equal(socketLineOf('a1d148c4@socket>helloWorld\r'), 'helloWorld');
  assert.equal(socketLineOf('a1d148c4@socket>helloWorld', 'a1d148c4'), 'helloWorld');
  assert.equal(socketLineOf('0dd04644@socket>unlock', 'a1d148c4'), null, 'another node put it on the socket');
  assert.equal(socketLineOf('host@socket>unlock', 'a1d148c4'), null);
  assert.equal(socketLineOf('socket out: helloWorld\r'), 'helloWorld');
  assert.equal(socketLineOf('[USB] hellooo'), 'hellooo'); // firmware before the socket block
  assert.equal(socketLineOf('socket in: G0 X1'), null); // what reached the board, not what it said
  assert.equal(socketLineOf('[CAN] tx hellooo'), null);
  assert.equal(socketLineOf('{"type":"io","pins":[]}'), null);
  assert.equal(socketLineOf('ok'), null);
  assert.equal(socketLineOf('[INFO] node=a1 type=logic'), null);
});

function board(id, direction, { live = true, nodeId = null } = {}) {
  return {
    id,
    name: id,
    logicalPorts: [{ id: `${id}-lp`, name: 'socket', direction }],
    ports: [{ id: `${id}-port`, logicalId: `${id}-lp` }],
    props: [{ name: 'connectionState', value: live ? 'connected:running' : 'disconnected' }, ...(nodeId ? [{ name: 'nodeId', value: nodeId }] : [])],
  };
}

function harness() {
  const listeners = new Map();
  const sent = [];
  const published = [];
  const values = new Map();
  const links = createSocketLinks({
    subscribeLines: (blockId, fn) => {
      listeners.set(blockId, fn);
      return () => listeners.delete(blockId);
    },
    isLive: (block) => block.props[0].value === 'connected:running',
    shell: async (blockId, line) => sent.push([blockId, line]),
    publish: (blockId, portId, value) => published.push([blockId, portId, value]),
    wireValue: (blockId, portId) => values.get(`${blockId}:${portId}`),
  });
  const say = (blockId, line, unsolicited = true) => listeners.get(blockId)?.({ line, unsolicited });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { links, listeners, sent, published, values, say, flush };
}

test('two boards wired socket to socket are left to their own link: the browser relays nothing', async () => {
  const h = harness();
  const s3 = board('s3', 'out');
  const cnc = board('cnc', 'in');
  const level = { connections: new Map([['w', { sourceBlockId: 's3', sourcePortId: 's3-port', targetBlockId: 'cnc', targetPortId: 'cnc-port' }]]) };
  const boards = [{ block: s3, level }, { block: cnc, level }];
  h.links.tick(boards);
  h.say('s3', 'a1d148c4@socket>hellooo');
  h.links.tick(boards);
  await h.flush();
  assert.deepEqual(h.sent, []);
  // The S3's own socket still carries what it said, for blocks reading it.
  assert.deepEqual(h.published.at(-1), ['s3', 's3-port', 'hellooo']);
});

test('the socket out publishes the latest line the board itself put on the socket', () => {
  const h = harness();
  const s3 = board('s3', 'out', { nodeId: 'a1d148c4' });
  const boards = [{ block: s3, level: { connections: new Map() } }];
  h.links.tick(boards);
  assert.deepEqual(h.published.at(-1), ['s3', 's3-port', undefined]);
  h.say('s3', 'a1d148c4@socket>42');
  h.links.tick(boards);
  assert.deepEqual(h.published.at(-1), ['s3', 's3-port', '42']);
  // What another node put on this board's socket is not this board's output.
  h.say('s3', '0dd04644@socket>ok');
  h.links.tick(boards);
  assert.deepEqual(h.published.at(-1), ['s3', 's3-port', '42']);
});

test('a plain value on a socket in is sent when it changes, and only then', async () => {
  const h = harness();
  const cnc = board('cnc', 'in');
  const level = { connections: new Map([['w', { sourceBlockId: 'data', sourcePortId: 'data-out', targetBlockId: 'cnc', targetPortId: 'cnc-port' }]]) };
  const boards = [{ block: cnc, level }];
  h.values.set('data:data-out', 'g G0 X5');
  h.links.tick(boards);
  h.links.tick(boards);
  h.values.set('data:data-out', 'g G0 X6');
  h.links.tick(boards);
  await h.flush();
  assert.deepEqual(h.sent, [['cnc', 'socket g G0 X5'], ['cnc', 'socket g G0 X6']]);
});

test('nothing is written to a board that is not live', async () => {
  const h = harness();
  const cnc = board('cnc', 'in', { live: false });
  const level = { connections: new Map([['w', { sourceBlockId: 'data', sourcePortId: 'data-out', targetBlockId: 'cnc', targetPortId: 'cnc-port' }]]) };
  const boards = [{ block: cnc, level }];
  h.values.set('data:data-out', 'g $X');
  h.links.tick(boards);
  await h.flush();
  assert.deepEqual(h.sent, []);
  cnc.props[0].value = 'connected:running';
  h.links.tick(boards);
  await h.flush();
  assert.deepEqual(h.sent, [['cnc', 'socket g $X']]);
});

test('a board that is gone from the diagram drops its subscription', () => {
  const h = harness();
  const s3 = board('s3', 'out');
  h.links.tick([{ block: s3, level: { connections: new Map() } }]);
  assert.ok(h.listeners.has('s3'));
  h.links.tick([]);
  assert.ok(!h.listeners.has('s3'));
});
