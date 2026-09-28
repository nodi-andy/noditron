import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHello, subnetsOf, sweepSubnets, mergeBoards } from '../server/src/lanDiscovery.js';

// Boards on the LAN, for the Add Block window's Connect IP: heard by their
// UDP hello, or found by asking every host of the server's own /24.

test('a board hello becomes a board record at the address it came from', () => {
  const b = parseHello('{"hello":1,"id":"0dd04644","type":"cnc","name":"CNC","version":"1.4","ip":"192.168.1.171","state":"idle"}', '192.168.1.171', 1000);
  assert.deepEqual(b, { id: '0dd04644', type: 'cnc', name: 'CNC', version: '1.4', ip: '192.168.1.171', reportedIp: '192.168.1.171', state: 'idle', lastSeen: 1000, via: 'hello' });
  const logic = parseHello('{"hello":1,"id":"a1d148c4","type":"logic","name":"esp32-s3","version":"1.2","ip":"192.168.0.1","circuit":"active"}', '192.168.1.174', 5);
  assert.equal(logic.ip, '192.168.1.174', 'the packet source, not the access-point address the board reports');
  assert.equal(logic.state, 'active');
  assert.equal(parseHello('not json', '1.2.3.4'), null);
  assert.equal(parseHello('{"hello":2,"id":"a1d148c4"}', '1.2.3.4'), null);
  assert.equal(parseHello('{"hello":1,"id":"nope"}', '1.2.3.4'), null);
});

test('only private IPv4 interfaces are swept, one /24 each', () => {
  const subnets = subnetsOf({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth: [{ address: '192.168.1.5', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    eth2: [{ address: '192.168.1.9', family: 'IPv4', internal: false }],
    vpn: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
    docker: [{ address: '172.17.0.1', family: 4, internal: false }],
    pub: [{ address: '8.8.4.4', family: 'IPv4', internal: false }],
  });
  assert.deepEqual(subnets.map((s) => [s.base, s.self]), [['192.168.1', '192.168.1.5'], ['10.8.0', '10.8.0.2'], ['172.17.0', '172.17.0.1']]);
});

test('the sweep asks every host but itself and keeps the boards that answer', async () => {
  const asked = [];
  const found = await sweepSubnets({
    subnets: [{ base: '192.168.1', self: '192.168.1.5' }],
    concurrency: 8,
    probe: async (ip) => {
      asked.push(ip);
      return ip === '192.168.1.171' ? { id: '0dd04644', type: 'cnc', name: 'CNC', build: '20260927a', ip, via: 'scan' } : null;
    },
  });
  assert.equal(asked.length, 253);
  assert.ok(!asked.includes('192.168.1.5'));
  assert.deepEqual(found.map((b) => b.ip), ['192.168.1.171']);
});

test('a sweep answer wins over a hello for the same board, sorted by address', () => {
  const merged = mergeBoards(
    [{ id: 'a1d148c4', type: 'logic', name: 'esp32-s3', ip: '192.168.1.174', via: 'hello' }, { id: '0dd04644', type: 'cnc', name: 'CNC', ip: '192.168.1.171', via: 'hello' }],
    [{ id: '0dd04644', type: 'cnc', name: 'CNC', build: '20260927a', ip: '192.168.1.171', via: 'scan' }, { id: '99999999', type: 'logic', name: 'other', ip: '192.168.1.20', via: 'scan' }],
  );
  assert.deepEqual(merged.map((b) => [b.ip, b.via, b.build || null]), [
    ['192.168.1.20', 'scan', null],
    ['192.168.1.171', 'hello+scan', '20260927a'],
    ['192.168.1.174', 'hello', null],
  ]);
});
