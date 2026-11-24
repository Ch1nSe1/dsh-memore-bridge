/**
 * 极简 mDNS 发现（2026-11-18）：找局域网里正在广播 `_memore._tcp` 的手机。
 *
 * 为什么自己写而不装包：插件要求零运行时依赖（插件市场的安装脚本不该顺带装
 * 一堆传递依赖），而这里只需要「发一条 PTR 查询、解析 SRV+A」这一小块。
 *
 * 协议要点（RFC 6762 / 6763）：
 *   - 组播地址 224.0.0.251:5353，TTL 255；发送方端口也是 5353（这样回复直接回来）
 *   - 名字用 label 序列，支持指针压缩（0xC0 开头）
 *   - 我们只关心 PTR（服务名）、SRV（端口 + 主机名）、A（IPv4）
 */
import dgram from 'node:dgram';
import os from 'node:os';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_memore._tcp.local';

/** 把 `_memore._tcp.local` 编码成 DNS 名字（label 长度 + 内容，0 结尾）。 */
function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

/**
 * 组装一条 PTR 查询报文（RFC 6762 §5.1 / §5.4）。
 *
 * 三个细节是实测踩出来的（2026-11-18）：Android 侧一直报
 * `Error while decoding multicast packet`，因为它按 mDNS 规范校验：
 *   · id **必须是 0**（mDNS 的查询不带事务号）
 *   · QCLASS 带 QU 位（0x8001）→ 应答方直接单播回我们的端口，
 *     否则应答走 5353 组播，我们这种临时端口根本收不到
 *   · 名字按 label 编码，末尾补 0
 */
function buildQuery(name) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0001, 0); // 实测 Android 只应 id=1 的查询
  header.writeUInt16BE(0x0000, 2); // flags: standard query
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(0, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(0, 10); // arcount
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // QTYPE PTR
  tail.writeUInt16BE(1, 2); // QCLASS IN
  return Buffer.concat([header, encodeName(name), tail]);
}

/** 解析压缩名字；返回 [名字, 下一个偏移]。 */
function parseName(buf, offset) {
  const labels = [];
  let pos = offset;
  let jumped = false;
  let next = offset;
  let guard = 0;
  while (guard++ < 128) {
    if (pos >= buf.length) break;
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      if (!jumped) next = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) next = pos + 2;
      jumped = true;
      pos = ptr;
      continue;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  if (!jumped) next = pos;
  return [labels.join('.'), next];
}

/**
 * 解析一条响应，收集 SRV 与 A。
 *
 * 关键（2026-11-18 实测）：Android 的 NsdManager 把 **SRV / TXT / A / AAAA 全放在
 * additional 段**（`ar=8`），answer 段只有一条 PTR。只读 answer 段会得到空结果——
 * 这正是「包收到了、却永远扫不到手机」的原因。所以三个段都要走。
 *
 * 返回 { srv: [{instance, port, target}], a: {host: ip} }。
 */
function parseResponse(buf) {
  const out = { srv: [], a: {} };
  if (buf.length < 12) return out;
  const qd = buf.readUInt16BE(4);
  const sections = [
    buf.readUInt16BE(6), // answer
    buf.readUInt16BE(8), // authority
    buf.readUInt16BE(10), // additional
  ];
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const [, p] = parseName(buf, pos);
    pos = p + 4; // type + class
  }
  for (const count of sections) {
    for (let i = 0; i < count; i++) {
      const [name, p1] = parseName(buf, pos);
      if (p1 + 10 > buf.length) return out;
      const type = buf.readUInt16BE(p1);
      const rdlen = buf.readUInt16BE(p1 + 8);
      const rdStart = p1 + 10;
      if (rdStart + rdlen > buf.length) return out;
      if (type === 33) {
        // SRV: priority(2) weight(2) port(2) target(name)
        const port = buf.readUInt16BE(rdStart + 4);
        const [target] = parseName(buf, rdStart + 6);
        out.srv.push({ instance: name.replace(/\.?$/, ''), port, target: target.replace(/\.?$/, '') });
      } else if (type === 1 && rdlen === 4) {
        const ip = [buf[rdStart], buf[rdStart + 1], buf[rdStart + 2], buf[rdStart + 3]].join('.');
        out.a[name.replace(/\.?$/, '')] = ip;
      }
      pos = rdStart + rdlen;
    }
  }
  return out;
}

/**
 * 本机可用的 IPv4，按「更像局域网」排序。
 *
 * 为什么要有顺序：这台机器有 6 个 IPv4（WLAN + 一个带 10.33 的虚拟网卡 + 若干 169.254）。
 * 实测把组播接口在多个网卡之间来回切，最后一条 send 会走错的网卡，手机就收不到查询；
 * 一次只喂一块网卡才稳定。所以这里排好序，由调用方逐块试。
 */
function rankedIPv4s() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const [name, list] of Object.entries(ifaces)) {
      for (const info of list ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        const ip = info.address;
        if (ip.startsWith('169.254.')) continue;
        if (ip.startsWith('100.')) continue; // Tailscale 网段没有组播
        const score = /^192\.168\./.test(ip) ? 3 : /^10\./.test(ip) ? 2 : 1;
        out.push({ name, ip, score });
      }
    }
  } catch {
    // 拿不到网卡信息就发默认路由
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.ip);
}

/** 单块网卡上扫一轮：绑 5353、只加这块网卡的组播组、发两次查询。 */
function discoverOnInterface(ip, waitMs) {
  return new Promise((resolve) => {
    const found = new Map();
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // 已关闭
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(done, waitMs);

    socket.on('error', () => {
      clearTimeout(timer);
      done();
    });

    socket.on('message', (msg) => {
      try {
        const { srv, a } = parseResponse(msg);
        for (const record of srv) {
          if (!/memore/i.test(record.instance)) continue;
          const host = a[record.target];
          if (!host || !record.port) continue;
          const base = `http://${host}:${record.port}`;
          found.set(base, { name: record.instance, host, port: record.port, base });
        }
      } catch {
        // 半截报文直接忽略
      }
    });

    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDR, ip);
      } catch {
        try {
          socket.addMembership(MDNS_ADDR);
        } catch {
          // 加不进组播组
        }
      }
      try {
        socket.setMulticastInterface(ip);
        socket.setMulticastTTL(255);
      } catch {
        // 平台限制
      }
      const query = buildQuery(SERVICE);
      const send = () => {
        try {
          socket.send(query, MDNS_PORT, MDNS_ADDR);
        } catch {
          // 已关闭
        }
      };
      send();
      setTimeout(send, 200);
    });
  });
}

/**
 * 扫一轮局域网里广播的手机。
 *
 * 关键实现细节（2026-11-18 实测踩出来，别再改回去）：
 *   1. **必须绑 5353**：Android 的 NsdManager 应答走组播回 5353；
 *      用临时端口 + QU 位它完全不回。
 *   2. **一次只喂一块网卡**：在多个网卡之间切 setMulticastInterface 会让
 *      最后一次 send 走错网卡，实测直接收不到任何应答。
 *   3. 查询包 id 必须是 0、名字按 label 编码，否则 Android 侧会报
 *      `Error while decoding multicast packet` 并忽略。
 */
export async function discoverMemore(timeoutMs = 1200) {
  const ifaces = rankedIPv4s();
  if (ifaces.length === 0) return [];
  // 第一块拿大头（实测第一轮常被 mDNS 的去重抑制吃掉，时间给足），
  // 剩下的留给第二块，防止虚拟网卡排在最前面。
  const first = Math.max(600, Math.floor(timeoutMs * 0.65));
  const second = Math.max(400, timeoutMs - first);
  const all = new Map();
  const firstList = await discoverOnInterface(ifaces[0], first);
  for (const item of firstList) all.set(item.base, item);
  if (all.size > 0) return [...all.values()];
  if (ifaces[1]) {
    const again = await discoverOnInterface(ifaces[1], second);
    for (const item of again) all.set(item.base, item);
  }
  return [...all.values()];
}


export { parseResponse };
