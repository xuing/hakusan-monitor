// Getting started page strings (merged into the main dictionaries in en/ja/zh.ts).
// Written to ASD-STE100: one instruction per sentence, imperative in
// procedures, at most 20 words in a procedure and 25 in a description, no
// semicolons, contractions or idioms, one word for one thing. The account
// form is a site fact: the site file's own start.account.note.
export const startEn = {
  "start.user.label": "User name",
  "start.os.label": "Operating system",

  "start.map.title": "From your computer to a compute node",
  "start.map.pc": "Your computer",
  "start.map.pcNote": "Use a terminal and ssh to connect to a login node.",
  "start.map.login": "Login nodes",
  "start.map.loginNote": "All users share the login nodes. Use them to edit code, copy files and submit jobs. Do not run computations on them.",
  "start.map.compute": "Compute nodes",
  "start.map.computeNote": "Slurm gives compute nodes to your jobs. Your programs run on these nodes.",
  "start.map.home": "The login nodes and the compute nodes use the same home directory (`~`). A file that you put in it on a login node is also on the compute nodes.",
  "start.lighter": "lower load",

  "start.connect.title": "Connect for the first time",
  "start.connect.lead": "macOS and Linux have ssh. Open a terminal. Type this command:",
  "start.connect.leadWin": "Open PowerShell 7 in Windows Terminal. Type this command:",
  "start.connect.installWin": "If you do not have PowerShell 7, install it with `winget install --id Microsoft.PowerShell --source winget`.",
  "start.connect.password": "The password does not show when you type it. After you type it, press Enter.",
  "start.connect.short": "`{short}` is short for `{host}`. On the campus network, your computer adds `.{domain}` automatically.",
  "start.connect.trust": "When you connect for the first time, ssh asks if you trust the host. Type `yes`.",
  "start.connect.pick": "The {n} login nodes use the same home directory. You can use any one of them. If a login node is busy, use a different one.",
  "start.connect.exit": "To disconnect, type `exit`.",

  "start.key.title": "Log in without a password",
  "start.key.lead": "An SSH key pair replaces the password. You keep the private key on your computer and put the public key on the cluster.",
  "start.key.step1": "Make a key pair. If `~/.ssh/id_ed25519` exists, skip this step. At each prompt, press Enter.",
  "start.key.step2": "Copy the public key to the cluster. When ssh asks for your password, type it. Do this one time only, because the login nodes use the same home directory.",
  "start.key.step3": "Connect again. If ssh does not ask for a password, the key works.",

  "start.config.title": "Connect without the user name",
  "start.config.lead": "Add these lines to `{path}`. If the file does not exist, make it. Then connect with `ssh {alias}`. scp, rsync and VS Code also use these settings.",
  "start.config.winNote": "The file name is `config`. Do not add a .txt extension.",

  "start.files.title": "Copy files and edit code",
  "start.files.lead": "Run these commands on your computer, not on a login node. They use the settings from the step above.",
  "start.files.up": "Upload",
  "start.files.down": "Download",
  "start.files.folder": "Upload a folder",
  "start.files.syncLabel": "Synchronize a folder",
  "start.files.sync": "rsync copies only the files that changed. If the copy stops, run the command again.",
  "start.files.gui": "You can also use a graphical tool, for example WinSCP, Cyberduck or FileZilla. Use the same host name, user name and key.",
  "start.files.vscode": "To edit files on the cluster in VS Code, install the Remote - SSH extension. Then connect to `{alias}`. The VS Code terminal also runs on the login node. For computations, use `salloc` or `sbatch`.",

  "start.fromSlurm": "If you have not used the cluster before, read {siteName} basics first. It shows how to connect with ssh and how to use SSH keys.",
} as const;

export type StartKey = keyof typeof startEn;
