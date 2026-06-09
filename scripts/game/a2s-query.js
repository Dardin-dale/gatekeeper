#!/usr/bin/env node
/**
 * Minimal Steam A2S_INFO query (no dependencies — just UDP via dgram).
 *
 * Used to validate the local AF container (Phase 3 Tier-2) and reused as the core
 * of the monitor Lambda: "does A2S answer?" = liveness, plus current player count.
 * Handles the modern A2S challenge handshake (servers reply 0x41 with a challenge
 * that must be echoed back).
 *
 * Usage:  node scripts/game/a2s-query.js [host=127.0.0.1] [port=27015] [timeoutMs=5000]
 * Exit 0 + "LIVE {...}" if the server answers; exit 1 + "DOWN <reason>" otherwise.
 */
const dgram = require('dgram');

const A2S_INFO_PAYLOAD = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
  Buffer.from('Source Engine Query\0', 'binary'),
]);

function a2sInfo(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.close();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => {
      const type = msg.readUInt8(4);
      if (type === 0x41) {
        // Challenge — re-send the request with the 4-byte challenge appended.
        const challenge = msg.subarray(5, 9);
        sock.send(Buffer.concat([A2S_INFO_PAYLOAD, challenge]), port, host);
        return;
      }
      if (type === 0x49) {
        // INFO response: header(4) type(1) protocol(1) then C-strings + numbers.
        let o = 6;
        const readCStr = () => {
          const start = o;
          while (o < msg.length && msg[o] !== 0) o++;
          const s = msg.toString('utf8', start, o);
          o++; // skip null
          return s;
        };
        const name = readCStr();
        const map = readCStr();
        readCStr(); // folder
        const game = readCStr();
        o += 2; // appid (int16)
        const players = msg.readUInt8(o++);
        const maxPlayers = msg.readUInt8(o++);
        finish(null, { name, map, game, players, maxPlayers });
        return;
      }
    });

    sock.send(A2S_INFO_PAYLOAD, port, host);
  });
}

module.exports = { a2sInfo };

if (require.main === module) {
  const host = process.argv[2] || '127.0.0.1';
  const port = Number(process.argv[3]) || 27015;
  const timeoutMs = Number(process.argv[4]) || 5000;
  a2sInfo(host, port, timeoutMs)
    .then((info) => {
      console.log('LIVE', JSON.stringify(info));
      process.exit(0);
    })
    .catch((err) => {
      console.log('DOWN', err.message);
      process.exit(1);
    });
}
