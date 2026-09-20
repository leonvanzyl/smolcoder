// The "models on other machines" flows, driven from the model picker in both
// UIs: search the network, type an address, and manage what was added. Nobody
// edits a file or runs a command — hosts are saved for them.
//
// A machine found by a search is never used until the user picks it: smolcoder
// sends source code to the server it talks to and runs the tool calls that
// come back, so choosing a host is choosing to trust it.

import { loadConfig, SavedHost, updateConfig } from "./config";
import { identifyServer, probeHosts, ServerInfo } from "./detect";
import { addHost, hostLabel, isPrivateHost, parseAddress, removeHost, renameHost } from "./hosts";
import { FoundHost, localSubnets, scanSubnets, Subnet } from "./netscan";
import { SelectOption } from "./ui";
import { plural } from "./util";

/** The slice of a UI these flows need — the TUI and the web channel both fit. */
export interface FlowUI {
  select(title: string, options: SelectOption[]): Promise<number | null>;
  prompt(title: string, placeholder?: string): Promise<string | null>;
  status(s: string): void;
  warn(s: string): void;
  startSpinner(label: string): void;
  stopSpinner(): void;
}

const BACKEND_NAMES = { ollama: "Ollama", lmstudio: "LM Studio", omlx: "oMLX" } as const;

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
    "  · Windows: allow the server through the firewall for Private networks when it asks.\n" +
    (platform === "darwin"
      ? "On this Mac: System Settings → Privacy & Security → Local Network must allow your terminal app, or nothing on the network is visible.\n"
      : "") +
    "Machines on a VPN or another network are not searched — use \"Enter an address\" for those."
  );
}

function save(hosts: SavedHost[]): SavedHost[] {
  return updateConfig({ hosts }).hosts ?? [];
}

async function confirmOutsideNetwork(ui: FlowUI, hostname: string, url: string): Promise<boolean> {
  if (url.startsWith("https://") || isPrivateHost(hostname)) return true;
  ui.warn(`${hostname} is outside your own network and the connection is plain http: your code and prompts would travel unencrypted.`);
  return (await ui.select(`Add ${hostname} anyway?`, [{ label: "Cancel" }, { label: "Add it anyway" }])) === 1;
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
    ui.warn(`Nothing answered at ${parsed.hostname} as Ollama or LM Studio.`);
    ui.status(notFoundHelp());
    return false;
  }
  if (!(await confirmOutsideNetwork(ui, parsed.hostname, found[0].baseUrl))) return false;
  let hosts = loadConfig().hosts ?? [];
  if (replace) hosts = removeHost(hosts, replace.address);
  save(addHost(hosts, { address: parsed.address, ...(replace?.name ? { name: replace.name } : {}) }));
  ui.status(`· added ${replace?.name ?? parsed.hostname} — ${describeServers(found.map((s) => ({ backend: s.backend, models: s.models.length })))}`);
  return true;
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
    // The name survives the router handing out a new IP; fall back to the IP.
    const base = replace ? removeHost(hosts, replace.address) : hosts;
    save(addHost(base, { address: f.name ?? f.ip, ...(replace?.name ? { name: replace.name } : {}) }));
    ui.status(`· added ${replace?.name ?? f.name ?? f.ip} — ${describeServers(f.servers)}`);
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
      ? [{ label: "Search my network", hint: `${subnets.map((s) => s.cidr).join(", ")} — looks for Ollama, LM Studio and oMLX` }]
      : []),
    { label: "Enter an address", hint: "IP, name or URL — also for VPNs and other networks" },
  ];
  if (!subnets.length) ui.status("· this computer is not on a home or office network I can search — you can still enter an address");
  const pick = await ui.select("Find models on another machine", options);
  if (pick === null) return false;
  return options[pick].label === "Search my network" ? searchNetwork(ui, subnets, replace) : enterAddress(ui, replace);
}

/** "Network hosts…": see what each added machine serves, rename or remove
 * it, or look for it again when its address changed. Returns true when the
 * list changed. */
export async function manageHosts(ui: FlowUI): Promise<boolean> {
  let changed = false;
  for (;;) {
    const hosts = loadConfig().hosts ?? [];
    if (!hosts.length) {
      if (!changed) ui.status("· no network hosts added yet");
      return changed;
    }
    ui.startSpinner("checking hosts");
    const statuses = await probeHosts(hosts);
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
    const actions: { label: string; hint?: string; run: "rename" | "remove" | "refind" }[] = [
      { label: "Rename", run: "rename" },
      { label: "Remove", run: "remove" },
    ];
    if (!servers.length) actions.push({ label: "Look for it again", hint: "its address may have changed", run: "refind" });
    const act = await ui.select(hostLabel(host), actions.map(({ label, hint }) => ({ label, hint })));
    if (act === null) continue;
    if (actions[act].run === "rename") {
      const name = await ui.prompt(`New name for ${hostLabel(host)}`, hostLabel(host));
      if (name) {
        save(renameHost(hosts, host.address, name));
        changed = true;
      }
    } else if (actions[act].run === "remove") {
      save(removeHost(hosts, host.address));
      ui.status(`· removed ${hostLabel(host)}`);
      changed = true;
    } else if (await findModelsOnNetwork(ui, host)) {
      changed = true;
    }
  }
}
