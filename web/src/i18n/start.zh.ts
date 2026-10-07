import type { StartKey } from "./start.en";

// The same rules as start.en.ts (ASD-STE100): short sentences, one
// instruction per sentence, no semicolons, one word for one thing.
export const startZh: Record<StartKey, string> = {
  "start.user.label": "用户名",
  "start.os.label": "操作系统",

  "start.map.title": "从你的电脑到计算节点",
  "start.map.pc": "你的电脑",
  "start.map.pcNote": "在终端里用 ssh 连接登录节点。",
  "start.map.login": "登录节点",
  "start.map.loginNote": "所有用户共用登录节点。在登录节点上编辑代码、复制文件、提交作业。不要在登录节点上运行计算。",
  "start.map.compute": "计算节点",
  "start.map.computeNote": "Slurm 把计算节点分配给你的作业。你的程序在计算节点上运行。",
  "start.map.home": "登录节点和计算节点使用同一个家目录（`~`）。你在登录节点上放进家目录的文件，在计算节点上也有。",
  "start.lighter": "负载较低",

  "start.connect.title": "第一次连接",
  "start.connect.lead": "macOS 和 Linux 都有 ssh。打开终端。输入以下命令：",
  "start.connect.leadWin": "在 Windows Terminal 里打开 PowerShell 7。输入以下命令：",
  "start.connect.installWin": "如果还没有 PowerShell 7，用 `winget install --id Microsoft.PowerShell --source winget` 安装。",
  "start.connect.password": "输入密码时，屏幕上不显示密码。输入密码后，按回车键。",
  "start.connect.short": "`{short}` 是 `{host}` 的简写。在校园网里，你的电脑会自动补上 `.{domain}`。",
  "start.connect.trust": "第一次连接时，ssh 会问你是否信任这台主机。输入 `yes`。",
  "start.connect.pick": "这 {n} 台登录节点使用同一个家目录。你可以连接其中任意一台。如果一台登录节点很忙，连接另一台。",
  "start.connect.exit": "要断开连接，输入 `exit`。",

  "start.key.title": "免密码登录",
  "start.key.lead": "SSH 密钥对代替密码。私钥留在你的电脑上，公钥放到集群上。",
  "start.key.step1": "生成密钥对。如果 `~/.ssh/id_ed25519` 已经存在，跳过这一步。出现提示时，按回车键。",
  "start.key.step2": "把公钥复制到集群上。ssh 要求输入密码时，输入密码。登录节点使用同一个家目录，所以这一步只做一次。",
  "start.key.step3": "再连接一次。如果 ssh 不再要求输入密码，密钥就可以用了。",

  "start.config.title": "连接时省略用户名",
  "start.config.lead": "把下面几行加到 `{path}`。如果这个文件不存在，新建它。之后用 `ssh {alias}` 连接。scp、rsync 和 VS Code 也使用这个设置。",
  "start.config.winNote": "文件名是 `config`。不要加 .txt 扩展名。",

  "start.files.title": "复制文件和编辑代码",
  "start.files.lead": "在你的电脑上运行这些命令，不要在登录节点上运行。这些命令使用上一步的设置。",
  "start.files.up": "上传",
  "start.files.down": "下载",
  "start.files.folder": "上传文件夹",
  "start.files.syncLabel": "同步文件夹",
  "start.files.sync": "rsync 只复制有变化的文件。如果复制中断，再运行一次这条命令。",
  "start.files.gui": "你也可以用图形界面工具，例如 WinSCP、Cyberduck 或 FileZilla。使用同样的主机名、用户名和密钥。",
  "start.files.vscode": "要在 VS Code 里编辑集群上的文件，安装 Remote - SSH 扩展。然后连接 `{alias}`。VS Code 的终端也在登录节点上运行。计算请用 `salloc` 或 `sbatch`。",

  "start.fromSlurm": "如果你没有用过这个集群，先读「{siteName} 使用入门」。它说明如何用 ssh 连接，以及如何使用 SSH 密钥。",
};
