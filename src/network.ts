// The "models on other machines" flows, driven from the model picker in both
// UIs: search the network, type an address, and manage what was added. Nobody
// edits a file or runs a command — hosts are saved for them.
//
// A machine found by a search is never used until the user picks it: smolcoder
// sends source code to the server it talks to and runs the tool calls that
// come back, so choosing a host is choosing to trust it.

import { loadConfig, SavedHost, savedKey, setKeys, updateConfig } from "./config";
import { identifyServer, probeHosts, ServerInfo } from "./detect";
import { addHost, hostLabel, hostUrls, isPrivateHost, parseAddress, removeHost, renameHost } from "./hosts";
import { FoundHost, localSubnets, scanSubnets, Subnet } from "./netscan";
import { PromptOptions, SelectOption } from "./ui";
import { plural } from "./util";

/** The slice of a UI these flows need — the TUI and the web channel both fit. */
export interface FlowUI {
  select(title: string, options: SelectOption[]): Promise<number | null>;
  prompt(title: string, placeholder?: string, opts?: PromptOptions): Promise<string | null>;
  status(s: string): void;
  warn(s: string): void;
  startSpinner(label: string): void;
  stopSpinner(): void;
}

export const BACKEND_NAMES = { ollama: "Ollama", lmstudio: "LM Studio", omlx: "oMLX", mtplx: "MTPLX" } as const;

function describeServers(servers: { backend: keyof typeof BACKEND_NAMES; models: number }[]): string {
  return servers.map((s) => `${BACKEND_NAMES[s.backend]} · ${plural(s.models, "model")}`).join(" + ");
}

/** Why a search or an address can come up empty. Both servers only listen to
 * their own machine until told otherwise, which is the usual reason. */
export function notFoundHelp(platform: NodeJS.Platform = process.platform): string {
  return (
    "A model server only answers other machines once it is told to. On the machine that runs the models:\n" +
    "  · Ollama: turn on \"Expose Ollama to the network\" in its settings (Linux or headless: set OLLAMA_HOST=0.0.0.0 and restart it).\n" +
    "  · LM Studio: Developer tab → Local Server → turn on \"Serve on Local Network\".\n" +
    "  · oMLX: Settings → Server → Listen Address → the network option. MTPLX: mtplx serve --host 0.0.0.0 --api-key <key>.\n" +
    "  · Windows: allow the server through the firewall for Private networks when it asks.\n" +
    (platform === "darwin"
      ? "On this Mac: System Settings → Privacy & Security → Local Network must allow your terminal app, or nothing on the network is visible.\n"
      : "") +
    "Machines on a VPN or another network are not searched — use \"Enter an address\" for those."
  );
}

// Servers that can require an API key.
export const KEYED: string[] = ["omlx", "mtplx"];
const LOOPBACK_URL = /^https?:\/\/(localhost|127(?:\.\d+){3}|\[::1\])(?=[:/]|$)/i;

function askKey(ui: FlowUI, what: string): Promise<string | undefined> {
  return ui.prompt(`API key for ${what}`, "the key set in the server's settings", { secret: true }).then((k) => k ?? undefined);
}

/** Which server a key is for. One keyed server needs no question. */
async function pickServer(ui: FlowUI, servers: ServerInfo[]): Promise<ServerInfo | null> {
  if (servers.length <= 1) return servers[0] ?? null;
  const pick = await ui.select("Which server?", servers.map((s) => ({ label: `${BACKEND_NAMES[s.backend]} · ${s.baseUrl}` })));
  return pick === null ? null : servers[pick];
}

interface FoundServer {
  backend: keyof typeof BACKEND_NAMES;
  url: string;
  models: number;
}

/** A scan or an address can turn up an oMLX or MTPLX that answers but lists
 * nothing until it has its key. Ask for each, check it with the server, and
 * update its model count in place. Returns the keys that worked, by the URL
 * the server answered on. Nothing is saved here: the machine may not be added,
 * and a search finds it by IP while it is saved by name. A key that is
 * skipped or refused leaves that server locked; the rest of the machine can
 * still be added. */
export async function unlockServers(ui: FlowUI, servers: FoundServer[], hostname: string): Promise<{ url: string; key: string }[]> {
  const keys: { url: string; key: string }[] = [];
  for (const s of servers) {
    if (!KEYED.includes(s.backend) || s.models > 0) continue;
    const name = BACKEND_NAMES[s.backend];
    if (!s.url.startsWith("https://") && !LOOPBACK_URL.test(s.url))
      ui.warn(`The connection to ${hostname} is plain http: the key travels unencrypted, so it is only as safe as that network.`);
    const key = await askKey(ui, `${name} at ${hostname}`);
    if (!key) continue;
    ui.startSpinner(`checking the key with ${hostname}`);
    const again = await identifyServer(s.url, 4000, key);
    ui.stopSpinner();
    if (!again?.models.length) {
      ui.warn(`${name} at ${hostname} did not accept that API key.`);
      continue;
    }
    keys.push({ url: s.url, key });
    s.models = again.models.length;
  }
  return keys;
}

/** The URL a saved address reaches a found server at: the same port, on the
 * name the machine is saved under. */
function savedUrlFor(address: string, url: string): string {
  const port = new URL(url).port;
  return hostUrls({ address }).find((u) => new URL(u).port === port) ?? url;
}

/** Save a machine once its servers are known and unlocked. Not when all it
 * runs is keyed servers that are still locked: added, it would list nothing.
 * Keys are saved for the address the machine is saved under, so detection
 * finds them; a replaced entry's keys go with it. Exported for tests. */
export function saveFoundMachine(
  ui: FlowUI,
  m: { address: string; hostname: string; servers: FoundServer[]; keys: { url: string; key: string }[]; replace?: SavedHost }
): boolean {
  if (m.servers.every((s) => KEYED.includes(s.backend) && !s.models)) {
    ui.warn(`${m.hostname} lists no models without its API key, so it was not added.`);
    return false;
  }
  let hosts = loadConfig().hosts ?? [];
  if (m.replace) {
    hosts = removeHost(hosts, m.replace.address);
    if (m.replace.address.toLowerCase() !== m.address.toLowerCase()) setKeys(hostUrls(m.replace));
  }
  save(addHost(hosts, { address: m.address, ...(m.replace?.name ? { name: m.replace.name } : {}) }));
  for (const k of m.keys) setKeys([savedUrlFor(m.address, k.url)], k.key);
  const label = m.replace?.name ?? m.hostname;
  ui.status(`· added ${label} — ${describeServers(m.servers)}`);
  for (const s of m.servers)
    if (KEYED.includes(s.backend) && !s.models)
      ui.status(`  ${BACKEND_NAMES[s.backend]} there still needs its API key: Network hosts → ${label} → API key.`);
  return true;
}

function save(hosts: SavedHost[]): SavedHost[] {
  return updateConfig({ hosts }).hosts ?? [];
}

async function confirmOutsideNetwork(ui: FlowUI, hostname: string, url: string): Promise<boolean> {
  if (url.startsWith("https://") || isPrivateHost(hostname)) return true;
  ui.warn(`${hostname} is outside your own network and the connection is plain http: your code and prompts would travel unencrypted.`);
  return (await ui.select(`Add ${hostname} anyway?`, [{ label: "Cancel" }, { label: "Add it anyway" }])) === 1;
}

export type AddResult =
  | { status: "added"; name: string; summary: string }
  | { status: "needs-key" | "bad-key"; name: string; host: string; message: string; secure: boolean }
  | { status: "outside"; host: string; message: string }
  | { status: "invalid" | "not-found"; message: string };

/** "Add a machine" from the web settings page, which cannot ask questions
 * mid-way: each answer it lacks comes back as a status (needs-key, outside)
 * and the page calls again with it. The checks and the saving are the same
 * as typing the address in the picker: unlock what the key opens, then
 * saveFoundMachine saves the machine and its keys under its address. */
export async function addMachine(typed: string, apiKey?: string, outsideOk = false): Promise<AddResult> {
  let parsed;
  try {
    parsed = parseAddress(typed);
  } catch (err: any) {
    return { status: "invalid", message: String(err?.message ?? err) };
  }
  const found = (await Promise.all(parsed.urls.map((u) => identifyServer(u, 4000)))).filter((s): s is ServerInfo => !!s);
  if (!found.length) return { status: "not-found", message: `Nothing answered at ${parsed.hostname} as a model server.` };
  if (!outsideOk && !found[0].baseUrl.startsWith("https://") && !isPrivateHost(parsed.hostname))
    return { status: "outside", host: parsed.hostname, message: `${parsed.hostname} is outside your own network and the connection is plain http: your code and prompts would travel unencrypted.` };
  const servers: FoundServer[] = found.map((x) => ({ backend: x.backend, url: x.baseUrl, models: x.models.length }));
  const locked = servers.filter((s) => KEYED.includes(s.backend) && !s.models);
  const keys: { url: string; key: string }[] = [];
  if (locked.length) {
    const name = BACKEND_NAMES[locked[0].backend];
    const secure = locked[0].url.startsWith("https://") || LOOPBACK_URL.test(locked[0].url);
    if (!apiKey) return { status: "needs-key", name, host: parsed.hostname, secure, message: `${name} at ${parsed.hostname} needs its API key.` };
    for (const s of locked) {
      const again = await identifyServer(s.url, 4000, apiKey);
      if (!again?.models.length) continue;
      keys.push({ url: s.url, key: apiKey });
      s.models = again.models.length;
    }
    if (!keys.length) return { status: "bad-key", name, host: parsed.hostname, secure, message: `${name} at ${parsed.hostname} did not accept that API key.` };
  }
  const said: string[] = [];
  const quiet = { status: (s: string) => said.push(s.replace(/^[·\s]+/, "")), warn: (s: string) => said.push(s), select: async () => null, prompt: async () => null, startSpinner() {}, stopSpinner() {} };
  if (!saveFoundMachine(quiet, { address: parsed.address, hostname: parsed.hostname, servers, keys }))
    return { status: "not-found", message: said.join(" ") };
  return { status: "added", name: parsed.hostname, summary: describeServers(servers) };
}

/** "Enter an address": returns true when a host was added. */
async function enterAddress(ui: FlowUI, replace?: SavedHost): Promise<boolean> {
  const typed = await ui.prompt("Address of the machine", "192.168.1.50, gpu-box.local or https://…");
  if (!typed) return false;
  let parsed;
  try {
    parsed = parseAddress(typed);
  } catch (err: any) {
    ui.warn(String(err?.message ?? err));
    return false;
  }
  ui.startSpinner(`checking ${parsed.hostname}`);
  const found = (await Promise.all(parsed.urls.map((u) => identifyServer(u, 4000)))).filter((s): s is ServerInfo => !!s);
  ui.stopSpinner();
  if (!found.length) {
    ui.warn(`Nothing answered at ${parsed.hostname} as a model server.`);
    ui.status(notFoundHelp());
    return false;
  }
  if (!(await confirmOutsideNetwork(ui, parsed.hostname, found[0].baseUrl))) return false;
  // oMLX and MTPLX answer /health without a key but list nothing without one.
  const servers = found.map((x) => ({ backend: x.backend, url: x.baseUrl, models: x.models.length }));
  const keys = await unlockServers(ui, servers, parsed.hostname);
  return saveFoundMachine(ui, { address: parsed.address, hostname: parsed.hostname, servers, keys, replace });
}

function savedAddressesOf(found: FoundHost, hosts: SavedHost[]): boolean {
  const mine = [found.ip, found.name, ...found.servers.map((s) => s.url)].filter(Boolean).map((s) => String(s).toLowerCase());
  return hosts.some((h) => mine.includes(h.address.toLowerCase()));
}

/** "Search my network": returns true when at least one host was added. */
async function searchNetwork(ui: FlowUI, subnets: Subnet[], replace?: SavedHost): Promise<boolean> {
  const range = subnets.map((s) => s.cidr).join(" and ");
  let lastTenth = -1;
  ui.startSpinner(`searching ${range}`);
  const found = await scanSubnets(subnets, {
    onProgress: (done, total) => {
      const tenth = Math.floor((done / total) * 10);
      if (tenth === lastTenth || tenth >= 10) return;
      lastTenth = tenth;
      ui.startSpinner(`searching ${range} · ${tenth * 10}%`);
    },
  });
  ui.stopSpinner();
  if (!found.length) {
    ui.warn(`No model server found on ${range}.`);
    ui.status(notFoundHelp());
    return false;
  }

  let added = false;
  for (;;) {
    const hosts = loadConfig().hosts ?? [];
    const options: SelectOption[] = found.map((f) => {
      const known = savedAddressesOf(f, hosts);
      return {
        label: f.name ? `${f.name} (${f.ip})` : f.ip,
        hint: describeServers(f.servers) + (known ? " · already added" : ""),
        current: known,
      };
    });
    if (added) options.push({ label: "Done" });
    const pick = await ui.select(added ? "Add another machine?" : "Found on your network — pick one to use", options);
    if (pick === null || pick >= found.length) return added;
    const f = found[pick];
    if (savedAddressesOf(f, hosts)) {
      ui.status(`· ${f.name ?? f.ip} is already added`);
      continue;
    }
    // A machine whose oMLX or MTPLX waits for its key is no use added with no
    // models: ask here, exactly as typing its address would.
    const servers = f.servers.map((x) => ({ backend: x.backend, url: x.url, models: x.models }));
    const keys = await unlockServers(ui, servers, f.name ?? f.ip);
    // The name survives the router handing out a new IP; fall back to the IP.
    if (!saveFoundMachine(ui, { address: f.name ?? f.ip, hostname: f.name ?? f.ip, servers, keys, replace })) continue;
    added = true;
    if (replace || found.every((x) => savedAddressesOf(x, loadConfig().hosts ?? []))) return true;
  }
}

/** The entry point behind "Find models on my network…". Returns true when the
 * host list changed, so the caller can look for models again. `replace`
 * swaps a stale entry for whatever is picked, keeping its name. */
export async function findModelsOnNetwork(ui: FlowUI, replace?: SavedHost): Promise<boolean> {
  const subnets = localSubnets();
  const options: SelectOption[] = [
    ...(subnets.length
      ? [{ label: "Search my network", hint: `${subnets.map((s) => s.cidr).join(", ")} — looks for Ollama, LM Studio, oMLX and MTPLX` }]
      : []),
    { label: "Enter an address", hint: "IP, name or URL — also for VPNs and other networks" },
  ];
  if (!subnets.length) ui.status("· this computer is not on a home or office network I can search — you can still enter an address");
  const pick = await ui.select("Find models on another machine", options);
  if (pick === null) return false;
  return options[pick].label === "Search my network" ? searchNetwork(ui, subnets, replace) : enterAddress(ui, replace);
}

/** "Network hosts…": see what each added machine serves, rename or remove
 * it, set its API key, or look for it again when its address changed. Returns true when the
 * list changed. */
export async function manageHosts(ui: FlowUI, probe = probeHosts): Promise<boolean> {
  let changed = false;
  for (;;) {
    const hosts = loadConfig().hosts ?? [];
    if (!hosts.length) {
      if (!changed) ui.status("· no network hosts added yet");
      return changed;
    }
    ui.startSpinner("checking hosts");
    const statuses = await probe(hosts);
    ui.stopSpinner();
    const pick = await ui.select(
      "Network hosts",
      statuses.map((s) => ({
        label: hostLabel(s.host),
        hint:
          (s.host.name ? `${s.host.address} · ` : "") +
          (s.servers.length ? describeServers(s.servers.map((x) => ({ backend: x.backend, models: x.models.length }))) : "not reachable right now"),
      }))
    );
    if (pick === null) return changed;
    const { host, servers } = statuses[pick];
    const actions: { label: string; hint?: string; run: "rename" | "remove" | "refind" | "key" | "unkey" }[] = [
      { label: "Rename", run: "rename" },
      { label: "Remove", run: "remove" },
    ];
    if (!servers.length) actions.push({ label: "Look for it again", hint: "its address may have changed", run: "refind" });
    // Keys belong to servers; offer them where a server can require one.
    const keyed = servers.filter((s) => KEYED.includes(s.backend));
    const hasKey = keyed.some((s) => savedKey(s.baseUrl));
    if (keyed.length) actions.push({ label: "API key", hint: hasKey ? "saved · enter a new one to replace it" : "the key set in the server's settings", run: "key" });
    if (hasKey) actions.push({ label: "Remove API key", run: "unkey" });
    const act = await ui.select(hostLabel(host), actions.map(({ label, hint }) => ({ label, hint })));
    if (act === null) continue;
    if (actions[act].run === "rename") {
      const name = await ui.prompt(`New name for ${hostLabel(host)}`, hostLabel(host));
      if (name) {
        save(renameHost(hosts, host.address, name));
        changed = true;
      }
    } else if (actions[act].run === "key") {
      // One machine can run an oMLX and an MTPLX, each with its own key.
      const server = await pickServer(ui, keyed);
      if (!server) continue;
      if (!server.baseUrl.startsWith("https://"))
        ui.warn(`${server.baseUrl} is plain http: the key travels unencrypted to it. Fine on this computer; on a network, only as safe as that network.`);
      const key = await askKey(ui, `${BACKEND_NAMES[server.backend]} at ${hostLabel(host)}`);
      if (key) {
        // Check it before it replaces a working one: a typo would otherwise
        // make the server's models quietly disappear.
        ui.startSpinner("checking the key");
        const again = await identifyServer(server.baseUrl, 4000, key);
        ui.stopSpinner();
        if (!again?.models.length) {
          ui.warn(`${BACKEND_NAMES[server.backend]} at ${hostLabel(host)} did not accept that API key${savedKey(server.baseUrl) ? " — the saved one is unchanged" : ""}.`);
          continue;
        }
        setKeys([server.baseUrl], key);
        ui.status(`· API key saved for ${BACKEND_NAMES[server.backend]} at ${hostLabel(host)}`);
        changed = true;
      }
    } else if (actions[act].run === "unkey") {
      const server = await pickServer(ui, keyed.filter((s) => savedKey(s.baseUrl)));
      if (!server) continue;
      setKeys([server.baseUrl]);
      ui.status(`· API key removed for ${BACKEND_NAMES[server.backend]} at ${hostLabel(host)}`);
      changed = true;
    } else if (actions[act].run === "remove") {
      save(removeHost(hosts, host.address));
      setKeys([...hostUrls(host), ...servers.map((s) => s.baseUrl)]);
      ui.status(`· removed ${hostLabel(host)}`);
      changed = true;
    } else if (await findModelsOnNetwork(ui, host)) {
      changed = true;
    }
  }
}
