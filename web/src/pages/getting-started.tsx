// The basics page ("Hakusan basics"): from a laptop to a compute node — ssh
// to a login node, a key instead of the password, a config that sets the user
// name, and copying files. The login hosts come from the site file
// (GET /api/site `access`); their load is the login-node monitor's. The
// reader's user name and system fill the commands and stay in this browser.
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, Cpu, Laptop, Server, type LucideIcon } from "lucide-react";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { Segmented } from "@/components/common/segmented";
import { Rich, Section, Terminal } from "@/components/guide/guide-parts";
import { useApi } from "@/hooks/use-api";
import { tOptional, useT } from "@/i18n";
import { api } from "@/lib/api";
import { getSite } from "@/lib/site";
import { cn } from "@/lib/utils";
import type { LoginNode } from "@/types/snapshot";

type Os = "unix" | "win";

const USER_KEY = "hm.sshUser";
const OS_KEY = "hm.sshOs";
const LOAD_POLL_MS = 60_000;
// a node counts as the less busy one when its load per core is this much lower
const LIGHTER_BY = 0.2;

// storage can be missing or throw (private mode, blocked site data)
function readStore(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeStore(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* the page works without it */
  }
}

/** What a user name may hold here; anything else would break the commands. */
const cleanUser = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);

function initialOs(): Os {
  const saved = readStore(OS_KEY);
  if (saved === "win" || saved === "unix") return saved;
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "win" : "unix";
}

/** The Windows stand-in for ssh-copy-id (PowerShell has none). */
const copyIdWindows = (target: string) =>
  `type $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh ${target} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"`;

/** The name people type: the host without the search domain, which the
 *  local network appends again (hakusan1 -> hakusan1.jaist.ac.jp). */
const shortName = (host: string, domain?: string) =>
  domain && host.endsWith(`.${domain}`) ? host.slice(0, -domain.length - 1) : host;

/** ~/.ssh/config: the user name for every login host, and a HostName only
 *  where the short name is not the host's name. ssh finds the key from
 *  `ssh-keygen` (~/.ssh/id_ed25519) by itself. */
function sshConfig(hosts: { id: string; name: string }[], user: string) {
  const plain = hosts.filter((h) => h.name === h.id).map((h) => h.id);
  return [
    ...hosts.filter((h) => h.name !== h.id).flatMap((h) => [`Host ${h.id}`, `    HostName ${h.name}`, `    User ${user}`]),
    ...(plain.length ? [`Host ${plain.join(" ")}`, `    User ${user}`] : []),
  ].join("\n");
}

export default function GettingStartedPage() {
  const t = useT();
  const access = getSite().access;
  const [user, setUserState] = useState(() => cleanUser(readStore(USER_KEY)));
  const [os, setOsState] = useState<Os>(initialOs);
  const login = useApi(() => api.loginNodes(), "login-nodes", LOAD_POLL_MS);

  if (!access?.login_hosts.length) return <Empty>—</Empty>;

  const setUser = (text: string) => {
    const next = cleanUser(text);
    setUserState(next);
    writeStore(USER_KEY, next);
  };
  const setOs = (next: Os) => {
    setOsState(next);
    writeStore(OS_KEY, next);
  };

  const domain = access.search_domain;
  const hosts = access.login_hosts.map((h) => ({ ...h, name: shortName(h.host, domain) }));
  const first = hosts[0];
  const alias = first.id;
  const name = user || access.user_example || "user";
  const target = `${name}@${first.name}`;
  const configPath = os === "win" ? "$HOME\\.ssh\\config" : "~/.ssh/config";

  // load per login host, and the clearly less busy one (none when they are close)
  const live = new Map<string, LoginNode>();
  for (const n of login.data?.nodes ?? []) if (n.ok && n.load && n.cores) live.set(n.id, n);
  const perCore = hosts.map((h) => live.get(h.id)?.load?.per_core).filter((v): v is number => v !== undefined);
  const lighter = perCore.length === hosts.length && hosts.length > 1 && Math.max(...perCore) - Math.min(...perCore) >= LIGHTER_BY
    ? hosts[perCore.indexOf(Math.min(...perCore))].id
    : null;

  return (
    <div className="space-y-4">
      {/* what fills the commands: the reader's name and system */}
      <SectionCard bodyClassName="pt-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-sm font-medium">{t("start.user.label")}</span>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={access.user_example || "user"}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className="h-8 w-36 rounded-md border border-border bg-background px-2 font-mono text-sm outline-none placeholder:text-muted-foreground/70 focus:border-primary"
            />
          </label>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">{t("start.os.label")}</span>
            <Segmented
              value={os}
              onChange={setOs}
              ariaLabel={t("start.os.label")}
              className="h-8"
              itemClassName="px-3"
              options={[{ value: "unix", label: "macOS / Linux" }, { value: "win", label: "Windows" }]}
            />
          </div>
        </div>
      </SectionCard>

      <Section id="map" title={t("start.map.title")}>
        <div className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center">
          <MapBox icon={Laptop} title={t("start.map.pc")} note={t("start.map.pcNote")} />
          <MapArrow label="ssh" />
          <MapBox icon={Server} title={t("start.map.login")} note={t("start.map.loginNote")}>
            <ul className="mt-2 space-y-1">
              {hosts.map((h) => {
                return (
                  <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <code className="font-mono text-xs text-foreground">{h.name}</code>
                    {lighter === h.id && (
                      <span className="rounded bg-ok-soft px-1.5 py-px text-xs font-medium text-ok-fg">{t("start.lighter")}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </MapBox>
          <MapArrow label="salloc / sbatch" />
          <MapBox icon={Cpu} title={t("start.map.compute")} note={t("start.map.computeNote")}>
            <Link to="/slurm" className="mt-2 inline-block text-xs text-info-fg hover:underline">{t("nav.slurm")} →</Link>
          </MapBox>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground"><Rich text={t("start.map.home")} /></p>
      </Section>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Section id="connect" title={t("start.connect.title")}>
          <Para className={os === "win" ? "mb-1.5" : undefined}><Rich text={t(os === "win" ? "start.connect.leadWin" : "start.connect.lead")} /></Para>
          {os === "win" && <Para><Rich text={t("start.connect.installWin")} /></Para>}
          <Terminal lines={[`ssh ${target}`]} />
          <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-muted-foreground">
            {first.name !== first.host && (
              <Bullet><Rich text={t("start.connect.short", { short: first.name, host: first.host, domain: domain ?? "" })} /></Bullet>
            )}
            {tOptional(t, "start.account.note") && <Bullet><Rich text={tOptional(t, "start.account.note")} /></Bullet>}
            <Bullet>{t("start.connect.password")}</Bullet>
            <Bullet><Rich text={t("start.connect.trust")} /></Bullet>
            {hosts.length > 1 && <Bullet>{t("start.connect.pick", { n: hosts.length })}</Bullet>}
            <Bullet><Rich text={t("start.connect.exit")} /></Bullet>
          </ul>
        </Section>

        <Section id="keys" title={t("start.key.title")}>
          <Para>{t("start.key.lead")}</Para>
          <ol className="space-y-4">
            <Step n={1} text={<Rich text={t("start.key.step1")} />}>
              <Terminal lines={["ssh-keygen -t ed25519"]} />
            </Step>
            <Step n={2} text={<Rich text={t("start.key.step2")} />}>
              <Terminal lines={[os === "win" ? copyIdWindows(target) : `ssh-copy-id ${target}`]} wrap={os === "win"} />
            </Step>
            <Step n={3} text={<Rich text={t("start.key.step3")} />}>
              <Terminal lines={[`ssh ${target}`]} />
            </Step>
          </ol>
        </Section>

        <Section id="config" title={t("start.config.title")}>
          <Para><Rich text={t("start.config.lead", { alias, path: configPath })} /></Para>
          <Terminal file={configPath} text={sshConfig(hosts, name)} />
          {os === "win" && <Para className="mt-3"><Rich text={t("start.config.winNote")} /></Para>}
          <Terminal lines={[`ssh ${alias}`]} className="mt-3" />
        </Section>

        <Section id="files" title={t("start.files.title")}>
          <Para><Rich text={t("start.files.lead", { alias })} /></Para>
          <div className="divide-y divide-border/60">
            <FileRow label={t("start.files.up")} command={`scp data.tar.gz ${alias}:~/`} />
            <FileRow label={t("start.files.down")} command={`scp ${alias}:~/result.csv .`} />
            {os === "win"
              ? <FileRow label={t("start.files.folder")} command={`scp -r project ${alias}:~/`} />
              : <FileRow label={t("start.files.syncLabel")} note={t("start.files.sync")} command={`rsync -avP project/ ${alias}:~/project/`} />}
          </div>
          <Para className="mt-3">{t("start.files.gui")}</Para>
          <Para className="mb-0"><Rich text={t("start.files.vscode", { alias })} /></Para>
        </Section>
      </div>

    </div>
  );
}

// ---- pieces ----------------------------------------------------------------------

function MapBox({ icon: Icon, title, note, children }: { icon: LucideIcon; title: string; note: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        {title}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{note}</p>
      {children}
    </div>
  );
}

/** The step between two boxes: down on a narrow screen, right on a wide one. */
function MapArrow({ label }: { label: string }) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-1.5 px-1 text-muted-foreground lg:flex-col lg:gap-0.5">
      <code className="font-mono text-xs">{label}</code>
      <ArrowRight className="h-4 w-4 rotate-90 lg:rotate-0" aria-hidden />
    </div>
  );
}

function Para({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("mb-3 text-sm leading-relaxed text-muted-foreground", className)}>{children}</p>;
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-info" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

function Step({ n, text, children }: { n: number; text: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5 gap-y-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-info-soft text-xs font-semibold text-info-fg">{n}</span>
      <p className="self-center text-sm leading-relaxed text-muted-foreground">{text}</p>
      <div className="col-start-2 min-w-0">{children}</div>
    </li>
  );
}

function FileRow({ label, note, command }: { label: string; note?: string; command: string }) {
  return (
    <div className="grid gap-x-4 gap-y-1.5 py-2.5 first:pt-0 md:grid-cols-[7rem_minmax(0,1fr)]">
      <div className="pt-1.5 text-sm font-medium">{label}</div>
      <div className="min-w-0">
        <Terminal lines={[command]} />
        {note && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}
