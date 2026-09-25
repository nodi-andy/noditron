import assert from 'node:assert/strict';
import test from 'node:test';

import { rememberPort, rememberedPort, forgetPort, findRememberedPort, describePortIdentity } from '../client/src/serialMemory.js';

function storage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

const usbPort = (usbVendorId, usbProductId) => ({ getInfo: () => ({ usbVendorId, usbProductId }) });

test('a USB port is remembered per block and found again among granted ports', () => {
  const store = storage();
  const s3 = usbPort(0x303a, 0x1001);
  assert.ok(rememberPort('board-1', s3, store));
  const remembered = rememberedPort('board-1', store);
  assert.equal(remembered.usbVendorId, 0x303a);
  assert.equal(remembered.usbProductId, 0x1001);

  const granted = [usbPort(0x10c4, 0xea60), usbPort(0x303a, 0x1001)];
  assert.equal(findRememberedPort(remembered, granted), granted[1]);
  assert.equal(describePortIdentity(granted[1]), 'USB 303a:1001');

  forgetPort('board-1', store);
  assert.equal(rememberedPort('board-1', store), null);
});

test('a port another board already holds is not offered twice', () => {
  const remembered = { usbVendorId: 0x303a, usbProductId: 0x1001 };
  const first = usbPort(0x303a, 0x1001);
  const second = usbPort(0x303a, 0x1001);
  assert.equal(findRememberedPort(remembered, [first, second], new Set([first])), second);
  assert.equal(findRememberedPort(remembered, [first], new Set([first])), null);
});

test('a port without USB ids is neither remembered nor matched', () => {
  const store = storage();
  assert.equal(rememberPort('board-2', { getInfo: () => ({}) }, store), null);
  assert.equal(store.size(), 0);
  assert.equal(findRememberedPort({ usbVendorId: null, usbProductId: null }, [{ getInfo: () => ({}) }]), null);
  assert.equal(describePortIdentity({ getInfo: () => ({}) }), 'serial port');
});
