/**
 * Tailscale 对端发现（2026-11-18）。
 *
 * 为什么用 `tailscale status --json` 而不是 mDNS：mDNS 只走同一个局域网，
 * 手机切到流量、只剩 Tailscale 时组播没有出口，扫不到（实测扫到 0 条）。
 * 而 Tailscale 客户端本来就知道每个对端的 100.x 地址，问它一次就行。
 *
 * 只取「在线 + 有 IPv4」的对端，Android 优先——那是手机。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 各平台 tailscale CLI 的常见位置；PATH 里的 `tailscale` 排在最前。 */
function candidates() {
  if (process.platform === 'win32') {
    return [
      'tailscale',
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      'tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/usr/local/bin/tailscale',
    ];
  }
  return ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale'];
}

/**
 * 列出 Tailscale 里在线的对端。
 * @param {number} timeoutMs 单次 CLI 调用上限（默认 1500ms）
 * @returns {Promise<Array<{name: string, os: string, ip: string}>>}
 */
export async function discoverTailnetPeers(timeoutMs = 1500) {
  for (const bin of candidates()) {
    try {
      const { stdout } = await run(bin, ['status', '--json'], {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 << 20,
      });
      const data = JSON.parse(stdout);
      const peers = Object.values(data.Peer ?? {});
      const out = [];
      for (const p of peers) {
        if (p?.Online === false) continue;
        const ip = (p?.TailscaleIPs ?? []).find((x) => typeof x === 'string' && x.startsWith('100.'));
        if (!ip) continue;
        out.push({ name: p.HostName || 'peer', os: String(p.OS || ''), ip });
      }
      // Android 优先：记忆库在那台手机上
      out.sort((a, b) => Number(b.os === 'android') - Number(a.os === 'android'));
      return out;
    } catch {
      // 这个路径没有 CLI / 没登录 / 超时 → 试下一个
    }
  }
  return [];
}
