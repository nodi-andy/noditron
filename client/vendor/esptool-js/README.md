# esptool-js (vendored)

`esptool-js.bundle.js` is the unmodified `bundle.js` from
[espressif/esptool-js](https://github.com/espressif/esptool-js) v0.6.1,
Espressif's own official in-browser Web Serial flasher — self-contained
(pako included), no build step, imported directly as an ES module by
`client/src/serialFlash.js`. Apache-2.0, see `LICENSE`.

To update: `npm pack esptool-js`, extract, copy `bundle.js` over this file
and `LICENSE` alongside it, bump the version note here.
