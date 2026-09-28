// What the embedded build ships in place of esptool-js (see
// tools/build-board-site.mjs): a page served by a board over plain HTTP
// has no Web Serial (a secure context is required), so nothing here can
// ever open a port or flash a chip — serialFlash.js's isSupported() is
// already false and the Add Block window's Connect USB tile disabled. The
// two classes exist so serialFlash.js's import resolves; used, they say
// why they cannot.
const NO_SERIAL = 'no serial port from a page served by a board: use the noditron app on a computer for USB';

export class Transport {
  constructor(device) {
    this.device = device;
    this.reader = undefined;
  }
  async disconnect() {
    try { await this.device?.close?.(); } catch { /* not open */ }
  }
  async rawRead() { throw new Error(NO_SERIAL); }
  async write() { throw new Error(NO_SERIAL); }
}

export class ESPLoader {
  constructor() { throw new Error(NO_SERIAL); }
}
