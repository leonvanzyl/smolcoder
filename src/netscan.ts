// "Find models on my network": an ordinary TCP connect sweep of the local
// subnet on the two model-server ports, then a question to each open port
// about what it is. No ping, no raw sockets, no admin rights — the same on
// Windows, macOS and Linux. Only ever run when the user asks for it.

import * as dns from "dns";
import * as net from "net";
import * as os from "os";
import { BackendKind, identifyServer } from "./detect";
import { LMSTUDIO_PORT, OLLAMA_PORT } from "./hosts";

export interface Subnet {
  /** e.g. "192.168.1.0/24" */
  cidr: string;
  /** Every usable address in it except our own. */
  addresses: string[];
}

export interface FoundServer {
  url: string;
  backend: BackendKind;
  models: number;
}

export interface FoundHost {
  ip: string;
  /** Name that resolves back to this machine, when the network has one. */
  name?: string;
  servers: FoundServer[];
}

const CONNECT_TIMEOUT_MS = 350;
// Well under macOS's default limit of 256 open files per process.
const CONCURRENCY = 64;
// Wider networks are searched around our own address only.
const MIN_PREFIX = 22;
const CLAMPED_PREFIX = 24;
// Virtual switches that never lead to another machine. Deliberately short:
// a Hyper-V "external" switch IS the real network, so names are not a general filter.
const VIRTUAL_IFACE = /^(vEthernet \((WSL|Default Switch)|docker\d*$|br-[0-9a-f]+$|veth[0-9a-f]+$|virbr\d*$)/i;

const toInt = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The private IPv4 networks this computer is on. Chosen by address, not by
 * adapter name, so it behaves the same on every OS. */
export function localSubnets(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): Subnet[] {
  const own = new Set<string>();
  for (const list of Object.values(ifaces)) for (const i of list ?? []) own.add(i.address);
  const subnets = new Map<string, Subnet>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const i of list ?? []) {
      const v4 = i.family === "IPv4" || (i.family as unknown) === 4;
      if (!v4 || i.internal || !isPrivateV4(i.address)) continue;
      const mask = toInt(i.netmask);
      let prefix = 0;
      for (let bit = 31; bit >= 0 && Math.floor(mask / 2 ** bit) % 2 === 1; bit--) prefix++;
      if (prefix >= 31) continue; // point-to-point link, nobody else on it
      if (prefix < MIN_PREFIX) prefix = CLAMPED_PREFIX;
      const size = 2 ** (32 - prefix);
      const network = Math.floor(toInt(i.address) / size) * size;
      const cidr = `${toIp(network)}/${prefix}`;
      if (subnets.has(cidr)) continue;
      const addresses: string[] = [];
      for (let n = network + 1; n < network + size - 1; n++) if (!own.has(toIp(n))) addresses.push(toIp(n));
      subnets.set(cidr, { cidr, addresses });
    }
  }
  return [...subnets.values()];
}

function canConnect(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** A name for the machine, but only one that leads back to the same address —
 * that is what makes it safe to save instead of an IP the router may reassign. */
function stableName(ip: string): Promise<string | undefined> {
  const lookup = async () => {
    try {
      for (const name of await dns.promises.reverse(ip)) {
        const back = await dns.promises.lookup(name, { family: 4 }).catch(() => null);
        if (back?.address === ip) return name.replace(/\.$/, "");
      }
    } catch {
      /* no reverse DNS on this network */
    }
    return undefined;
  };
  // A resolver that never answers must not stall the results; the IP will do.
  return Promise.race([lookup(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500).unref())]);
}

export interface ScanOptions {
  ports?: number[];
  connectTimeoutMs?: number;
  /** Called as addresses are checked: (checked, total). */
  onProgress?: (done: number, total: number) => void;
}

/** Sweep the subnets and report every machine running Ollama or LM Studio. */
export async function scanSubnets(subnets: Subnet[], opts: ScanOptions = {}): Promise<FoundHost[]> {
  const ports = opts.ports ?? [OLLAMA_PORT, LMSTUDIO_PORT];
  const timeout = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const targets = subnets.flatMap((s) => s.addresses).flatMap((ip) => ports.map((port) => ({ ip, port })));
  const open: { ip: string; port: number }[] = [];
  let next = 0;
  let checked = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++];
      if (await canConnect(target.ip, target.port, timeout)) open.push(target);
      opts.onProgress?.(++checked, targets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  const byIp = new Map<string, FoundHost>();
  await Promise.all(
    open.map(async ({ ip, port }) => {
      const info = await identifyServer(`http://${ip}:${port}`);
      if (!info) return;
      const host = byIp.get(ip) ?? { ip, servers: [] };
      host.servers.push({ url: info.baseUrl, backend: info.backend, models: info.models.length });
      byIp.set(ip, host);
    })
  );
  const hosts = [...byIp.values()].sort((a, b) => toInt(a.ip) - toInt(b.ip));
  await Promise.all(hosts.map(async (h) => (h.name = await stableName(h.ip))));
  return hosts;
}
