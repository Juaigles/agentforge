// Servidor DNS mínimo pero real: escucha por UDP y responde consultas de tipo A con el protocolo de cable de DNS
// (RFC 1035). Sirve para probar la fijación de DNS contra una resolución de verdad, sin inyectar funciones.
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';

export interface DnsServer {
  port: number;
  /** Nombres consultados (solo consultas de tipo A), en orden. */
  queries: string[];
  close(): Promise<void>;
}

/** `answer` decide qué direcciones IPv4 devolver a cada consulta (por nombre y número de consulta para ese nombre). */
export async function startDnsServer(answer: (name: string, nth: number) => string[]): Promise<DnsServer> {
  const socket = dgram.createSocket('udp4');
  const queries: string[] = [];
  const counts = new Map<string, number>();

  socket.on('message', (msg, rinfo) => {
    // Cabecera (12 bytes) + una pregunta: nombre en etiquetas, tipo y clase.
    const labels: string[] = [];
    let offset = 12;
    while (msg[offset] !== 0) {
      const length = msg[offset];
      labels.push(msg.subarray(offset + 1, offset + 1 + length).toString('ascii'));
      offset += 1 + length;
    }
    offset += 1;
    const qtype = msg.readUInt16BE(offset);
    const question = msg.subarray(12, offset + 4);
    const name = labels.join('.').toLowerCase();

    let addresses: string[] = [];
    if (qtype === 1) {
      const nth = (counts.get(name) ?? 0) + 1;
      counts.set(name, nth);
      queries.push(name);
      addresses = answer(name, nth);
    }
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // mismo identificador
    header.writeUInt16BE(0x8180, 2); // respuesta, recursión disponible, sin error
    header.writeUInt16BE(1, 4); // una pregunta
    header.writeUInt16BE(addresses.length, 6);
    const records = addresses.map((ip) => {
      const record = Buffer.alloc(16);
      record.writeUInt16BE(0xc00c, 0); // puntero al nombre de la pregunta
      record.writeUInt16BE(1, 2); // tipo A
      record.writeUInt16BE(1, 4); // clase IN
      record.writeUInt32BE(0, 6); // TTL 0: nada de cachés
      record.writeUInt16BE(4, 10);
      ip.split('.').forEach((octet, i) => record.writeUInt8(Number(octet), 12 + i));
      return record;
    });
    socket.send(Buffer.concat([header, question, ...records]), rinfo.port, rinfo.address);
  });

  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: (socket.address() as AddressInfo).port,
    queries,
    close: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}
