// A stand-in for the Go native messaging host, for tests/e2e.test.mjs.
//
// It speaks the same framed-JSON protocol as ts-browser-ext.go — a length
// prefix and a JSON body, procRunning on startup, an init reply, statuses —
// but starts no tailnet and needs no login. That is enough to drive the
// extension through the thing the mocks cannot reach: a real browser starting
// this process, killing it, and starting it again.
import fs from "node:fs";

const log = (m) => fs.appendFileSync(process.env.FAKE_BACKEND_LOG, `${process.pid} ${m}\n`);
const PORT = Number(process.env.FAKE_BACKEND_PORT || 41234);

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([len, body]));
  log(`-> ${JSON.stringify(obj)}`);
}

const RUNNING = { running: true, tailnet: "fake.example", browseToURL: "" };
const STOPPED = { running: false, error: "State: Stopped", browseToURL: "" };
let state = RUNNING;

fs.appendFileSync(process.env.FAKE_BACKEND_PIDS, `${process.pid}\n`);
log(`started, proxy port ${PORT}`);
send({ procRunning: { port: PORT, pid: process.pid, error: "" } });

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
    buf = buf.subarray(4 + len);
    log(`<- ${JSON.stringify(msg)}`);
    switch (msg.cmd) {
      case "init":
        send({ init: { error: "" } });
        send({ status: state });
        break;
      case "get-status":
        send({ status: state });
        break;
      case "up":
        state = RUNNING;
        send({ status: state });
        break;
      case "down":
        state = STOPPED;
        send({ status: state });
        break;
    }
  }
});

// The browser closing the pipe is how a real host learns it is finished.
process.stdin.on("end", () => {
  log("stdin closed, exiting");
  process.exit(0);
});
