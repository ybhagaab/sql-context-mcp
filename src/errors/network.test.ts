/**
 * Network checks: address classification, the DNS lookup and the TCP check, with real local
 * sockets where possible.
 */
import { describe, test, expect, afterEach } from 'vitest';
import * as net from 'net';
import { isPrivateAddress, isLoopbackAddress, isLoopbackHost, lookupHost, probeTcp, __setNetworkForTests } from './network';

afterEach(() => __setNetworkForTests(null));

describe('address classification', () => {
  test.each([
    ['10.253.59.227', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.10', true],
    ['100.64.0.1', true],
    ['100.128.0.1', false],
    ['169.254.10.1', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['fd12:3456::1', true],
    ['fc00::1', true],
    ['fe80::1', true],
    ['::ffff:10.1.2.3', true],
    ['52.66.1.2', false],
    ['2600:1f18::1', false],
    ['not-an-ip', false],
  ])('%s private: %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  test('loopback', () => {
    expect(isLoopbackAddress('127.0.0.53')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('db.localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('lookupHost', () => {
  test('an IP address needs no lookup', async () => {
    __setNetworkForTests({ lookup: async () => { throw new Error('should not be called'); } });
    expect(await lookupHost('10.1.2.3')).toEqual({ ok: true, addresses: [{ address: '10.1.2.3', family: 4 }], ms: 0 });
  });

  test('localhost resolves to a loopback address', async () => {
    const result = await lookupHost('localhost');
    expect(result.ok).toBe(true);
    expect(result.addresses.every((a) => isLoopbackAddress(a.address))).toBe(true);
  });

  test('a lookup that never answers stops at the time limit', async () => {
    __setNetworkForTests({ lookup: () => new Promise(() => undefined) });
    const started = Date.now();
    const result = await lookupHost('db.example', 100);
    expect(result).toMatchObject({ ok: false, code: 'ETIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a lookup error keeps its code', async () => {
    __setNetworkForTests({ lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }); } });
    expect(await lookupHost('x')).toMatchObject({ ok: false, code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' });
  });
});

describe('probeTcp', () => {
  test('open, and the socket is closed again', async () => {
    let closed = false;
    const server = net.createServer((socket) => {
      socket.on('close', () => { closed = true; });
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const result = await probeTcp('127.0.0.1', port, 2_000);
    expect(result).toMatchObject({ outcome: 'open', address: '127.0.0.1', port });
    for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('refused', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeTcp('127.0.0.1', port, 2_000)).toMatchObject({ outcome: 'refused', code: 'ECONNREFUSED' });
  });

  test('no answer: stops at the time limit', async () => {
    // TEST-NET-1 (RFC 5737) is never routed; depending on the network the attempt times out or is unreachable.
    const started = Date.now();
    const result = await probeTcp('192.0.2.1', 5439, 200);
    expect(['timeout', 'unreachable']).toContain(result.outcome);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a probe implementation that throws is reported, not thrown', async () => {
    __setNetworkForTests({ probe: async () => { throw Object.assign(new Error('boom'), { code: 'EHOSTUNREACH' }); } });
    expect(await probeTcp('10.0.0.1', 1, 100)).toMatchObject({ outcome: 'unreachable', code: 'EHOSTUNREACH' });
  });
});
