// Network hosts: other machines that serve models. People add them from the
// model picker by searching the network or typing an address, so everything
// here accepts loose input ("192.168.1.50", "gpu-box.local", "box:1234",
// "https://llm.example.com") and works out the rest.

import { SavedHost } from "./config";

export const OLLAMA_PORT = 11434;
export const LMSTUDIO_PORT = 1234;
export const OMLX_PORT = 8000;

export interface ParsedAddress {
  /** Normalized form to save. */
  address: string;
  /** Host part, for display. */
  hostname: string;
  /** Server URLs to try. A bare host means "every usual port"; anything more
   * specific names exactly one server. */
  urls: string[];
}

/** Parse what someone typed into the address box. Throws a plain-English
 * error for input that cannot be a server address. */
export function parseAddress(input: string): ParsedAddress {
  let text = String(input ?? "").trim();
  if (!text) throw new Error("Type the address of the machine that runs your models.");
  if (/\s/.test(text)) throw new Error("An address cannot contain spaces.");
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) throw new Error("Only http:// and https:// addresses work here.");
  if (schemeMatch && text.length === schemeMatch[0].length) throw new Error("The address needs a host name or IP.");
  text = text.replace(/\/+$/, "");
  // A bare IPv6 address needs brackets before it can carry a port.
  if (!schemeMatch && !text.startsWith("[") && (text.match(/:/g) ?? []).length > 1) text = `[${text}]`;
  let url: URL;
  try {
    url = new URL(schemeMatch ? text : `http://${text}`);
  } catch {
    throw new Error(`"${input.trim()}" is not an address I can connect to. Try an IP like 192.168.1.50 or a name like gpu-box.local.`);
  }
  if (url.username || url.password) throw new Error("Leave user names and passwords out of the address.");
  if (!url.hostname) throw new Error("The address needs a host name or IP.");
  if (/^(0\.0\.0\.0|\[::\])$/.test(url.hostname))
    throw new Error("0.0.0.0 is what a server listens on, not where to reach it. Use that machine's IP or name.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const pathPart = url.pathname.replace(/\/+$/, "");
  // URL drops a default port ("box:80"), so look at the text for one too.
  const portTyped = /:\d+$/.test(text.replace(/^\[[^\]]*\]/, ""));
  if (schemeMatch || portTyped || pathPart) {
    const base = `${url.protocol}//${url.host}${pathPart}`;
    return { address: base, hostname, urls: [base] };
  }
  return { address: url.hostname, hostname, urls: [OLLAMA_PORT, LMSTUDIO_PORT, OMLX_PORT].map((port) => `http://${url.host}:${port}`) };
}

/** Server URLs for a saved host; empty when the entry is unusable. */
export function hostUrls(host: SavedHost): string[] {
  try {
    return parseAddress(host.address).urls;
  } catch {
    return [];
  }
}

export function hostLabel(host: SavedHost): string {
  if (host.name) return host.name;
  try {
    return parseAddress(host.address).hostname;
  } catch {
    return host.address;
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Add a host, or update the name of one that is already there. */
export function addHost(hosts: SavedHost[], host: SavedHost): SavedHost[] {
  const at = hosts.findIndex((h) => sameAddress(h.address, host.address));
  if (at < 0) return [...hosts, host];
  return hosts.map((h, i) => (i === at ? { ...h, ...(host.name ? { name: host.name } : {}) } : h));
}

export function removeHost(hosts: SavedHost[], address: string): SavedHost[] {
  return hosts.filter((h) => !sameAddress(h.address, address));
}

export function renameHost(hosts: SavedHost[], address: string, name: string): SavedHost[] {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
  return hosts.map((h) => (sameAddress(h.address, address) ? (clean ? { ...h, name: clean } : { address: h.address }) : h));
}

/** True for addresses that stay inside a home or office network (and for
 * names, which we cannot judge). Used to warn before sending code over plain
 * http to somewhere on the internet. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  // Single-label and .local/.lan/.home names resolve inside the network.
  return !h.includes(".") || /\.(local|lan|home|internal|localdomain|home\.arpa|ts\.net)$/.test(h);
}
