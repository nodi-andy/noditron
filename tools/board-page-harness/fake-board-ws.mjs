// A Logic Module's console socket (port 81) as the page sees it (see
// client/src/wifiTransport.js): {type:'shell', line} in, {type:'shell',
// output} out, every reply ending in `ok`. Only what the board page's
// boot asks: ping (the two [INFO] lines) and anything else answered ok.
import { WebSocketServer } from '../../server/node_modules/ws/wrapper.mjs';

const port = Number(process.argv[2] || 81);
const wss = new WebSocketServer({ port });
const INFO = [
  '[INFO] LogicMod v1.2 build 20260927e | AP=LOGICMOD-48C4 | IP=192.168.0.1 | heap=250000 | circuit=none nCB=0',
  '[INFO] node=a1d148c4 type=logic name=esp32-s3',
];
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let message = null;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message?.type !== 'shell') return;
    const line = String(message.line || '').trim();
    process.stdout.write(`shell: ${line}\n`);
    let output = 'ok\n';
    if (line === 'ping') output = `${INFO.join('\n')}\nok\n`;
    // The bus as the S3 hears it: itself, and a CNC module over CAN.
    if (line === 'nodes') output = 'logic a1d148c4 esp32-s3 v1.2 self\ncnc 0dd04644 CNC v1.4 seen 1s ago via can\nok\n';
    ws.send(JSON.stringify({ type: 'shell', output }));
  });
});
console.log('fake board console on', port);
