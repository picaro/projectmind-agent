/**
 * Public UDP port for a service on a home computer.
 * The computer connects outward. Internet clients send UDP to this process.
 * A probe packet is answered here and is not forwarded.
 */
import dgram from "node:dgram";
import net from "node:net";

export const PORT_RELAY_PROBE = Buffer.from("PMR1");
export const PORT_RELAY_PROBE_OK = Buffer.from("PMR1OK");

type Remote = { address: string; port: number };

function remoteKey(remote: Remote): string {
  return `${remote.address}:${remote.port}`;
}

function encodeFrame(kind: number, remote: Remote, payload: Buffer): Buffer {
  const parts = remote.address.split(".").map((part) => Number(part));
  const header = Buffer.alloc(9);
  header.writeUInt8(kind, 0);
  header.writeUInt8(parts[0] ?? 0, 1);
  header.writeUInt8(parts[1] ?? 0, 2);
  header.writeUInt8(parts[2] ?? 0, 3);
  header.writeUInt8(parts[3] ?? 0, 4);
  header.writeUInt16BE(remote.port, 5);
  header.writeUInt16BE(payload.length, 7);
  return Buffer.concat([header, payload]);
}

function decodeFrame(
  buffer: Buffer,
): { frame: { kind: number; remote: Remote; payload: Buffer }; rest: Buffer } | null {
  if (buffer.length < 9) return null;
  const length = buffer.readUInt16BE(7);
  if (buffer.length < 9 + length) return null;
  const remote = {
    address: `${buffer[1]}.${buffer[2]}.${buffer[3]}.${buffer[4]}`,
    port: buffer.readUInt16BE(5),
  };
  return {
    frame: { kind: buffer[0] ?? 0, remote, payload: buffer.subarray(9, 9 + length) },
    rest: buffer.subarray(9 + length),
  };
}

export type PortRelayHandle = {
  host: string;
  udpPort: number;
  controlPort: number;
  close: () => Promise<void>;
};

export async function startPortRelay(input: {
  token: string;
  host?: string;
  udpPort?: number;
  controlPort?: number;
}): Promise<PortRelayHandle> {
  const host = input.host ?? "127.0.0.1";
  const udp = dgram.createSocket("udp4");
  const control = net.createServer();
  let connector: net.Socket | null = null;
  let attached = false;

  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(input.udpPort ?? 0, host, () => resolve());
  });

  const takeFrames = (socket: net.Socket, buffer: Buffer): Buffer => {
    let rest = buffer;
    for (;;) {
      const decoded = decodeFrame(rest);
      if (!decoded) return rest;
      rest = decoded.rest;
      if (decoded.frame.kind !== 2 || !attached) continue;
      udp.send(decoded.frame.payload, decoded.frame.remote.port, decoded.frame.remote.address);
    }
  };

  udp.on("message", (msg, rinfo) => {
    if (msg.subarray(0, PORT_RELAY_PROBE.length).equals(PORT_RELAY_PROBE)) {
      if (attached) udp.send(PORT_RELAY_PROBE_OK, rinfo.port, rinfo.address);
      return;
    }
    if (!connector || !attached) return;
    connector.write(encodeFrame(1, { address: rinfo.address, port: rinfo.port }, msg));
  });

  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(input.controlPort ?? 0, host, () => resolve());
  });

  control.on("connection", (socket) => {
    let buf: Buffer = Buffer.alloc(0);
    let authed = false;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (!authed) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        if (line !== `CONNECT ${input.token}`) {
          socket.end();
          return;
        }
        authed = true;
        attached = true;
        connector = socket;
        socket.write("OK\n");
      }
      buf = takeFrames(socket, buf);
    });
    socket.on("close", () => {
      if (connector === socket) {
        connector = null;
        attached = false;
      }
    });
  });

  const udpAddr = udp.address();
  const controlAddr = control.address();
  return {
    host,
    udpPort: typeof udpAddr === "object" ? udpAddr.port : 0,
    controlPort: controlAddr && typeof controlAddr === "object" ? controlAddr.port : 0,
    close: () =>
      new Promise((resolve) => {
        connector?.destroy();
        control.close(() => {
          udp.close(() => resolve());
        });
      }),
  };
}

export function connectPortRelay(input: {
  host: string;
  controlPort: number;
  token: string;
  localHost?: string;
  localPort: number;
}): Promise<{ close: () => void; closed: Promise<void> }> {
  const localHost = input.localHost ?? "127.0.0.1";
  const socket = net.connect({ host: input.host, port: input.controlPort });
  const locals = new Map<string, dgram.Socket>();
  let buf: Buffer = Buffer.alloc(0);
  let authed = false;

  const localSocket = (remote: Remote) => {
    const key = remoteKey(remote);
    const existing = locals.get(key);
    if (existing) return existing;
    const udp = dgram.createSocket("udp4");
    udp.on("message", (msg) => {
      if (!socket.destroyed) socket.write(encodeFrame(2, remote, msg));
    });
    locals.set(key, udp);
    return udp;
  };

  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (!authed) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        if (line !== "OK") {
          fail(new Error("Port relay refused the connection."));
          return;
        }
        authed = true;
        socket.off("error", fail);
        const closed = new Promise<void>((done) => {
          socket.on("close", () => done());
        });
        resolve({
          closed,
          close: () => {
            socket.destroy();
            for (const udp of locals.values()) udp.close();
          },
        });
      }
      for (;;) {
        const decoded = decodeFrame(buf);
        if (!decoded) break;
        buf = decoded.rest;
        if (decoded.frame.kind !== 1) continue;
        localSocket(decoded.frame.remote).send(decoded.frame.payload, input.localPort, localHost);
      }
    });
    socket.write(`CONNECT ${input.token}\n`);
  });
}

export function probePortRelay(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const udp = dgram.createSocket("udp4");
    const finish = (ok: boolean) => {
      udp.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    udp.on("message", (msg) => {
      clearTimeout(timer);
      finish(msg.equals(PORT_RELAY_PROBE_OK));
    });
    udp.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    udp.send(PORT_RELAY_PROBE, port, host);
  });
}
