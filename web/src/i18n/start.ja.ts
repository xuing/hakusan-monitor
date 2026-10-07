import type { StartKey } from "./start.en";

// The same rules as start.en.ts (ASD-STE100): short sentences, one
// instruction per sentence, no semicolons, one word for one thing.
export const startJa: Record<StartKey, string> = {
  "start.user.label": "ユーザー名",
  "start.os.label": "OS",

  "start.map.title": "手元の PC から計算ノードまで",
  "start.map.pc": "手元の PC",
  "start.map.pcNote": "ターミナルで ssh を使い、ログインノードに接続します。",
  "start.map.login": "ログインノード",
  "start.map.loginNote": "ログインノードは全ユーザーで共用します。ログインノードでは、コードの編集、ファイルのコピー、ジョブの投入をします。ログインノードで計算を実行しないでください。",
  "start.map.compute": "計算ノード",
  "start.map.computeNote": "Slurm がジョブに計算ノードを割り当てます。プログラムは計算ノードで実行されます。",
  "start.map.home": "ログインノードと計算ノードは同じホームディレクトリ（`~`）を使います。ログインノードでホームディレクトリに置いたファイルは、計算ノードでも使えます。",
  "start.lighter": "負荷が低い",

  "start.connect.title": "はじめての接続",
  "start.connect.lead": "macOS と Linux には ssh があります。ターミナルを開きます。次のコマンドを入力します：",
  "start.connect.leadWin": "Windows Terminal で PowerShell 7 を開きます。次のコマンドを入力します：",
  "start.connect.installWin": "PowerShell 7 がないときは、`winget install --id Microsoft.PowerShell --source winget` でインストールします。",
  "start.connect.password": "パスワードは入力しても画面に表示されません。入力したら Enter キーを押します。",
  "start.connect.short": "`{short}` は `{host}` の省略形です。学内ネットワークでは、PC が `.{domain}` を自動で補います。",
  "start.connect.trust": "はじめて接続すると、ssh がこのホストを信頼するか聞きます。`yes` と入力します。",
  "start.connect.pick": "{n} 台のログインノードは同じホームディレクトリを使います。どのログインノードに接続しても同じです。混んでいるときは、別のログインノードに接続します。",
  "start.connect.exit": "接続を終えるには、`exit` と入力します。",

  "start.key.title": "パスワードなしでログイン",
  "start.key.lead": "SSH の鍵ペアをパスワードの代わりに使います。秘密鍵は手元の PC に置き、公開鍵はクラスタに置きます。",
  "start.key.step1": "鍵ペアを作ります。`~/.ssh/id_ed25519` がすでにあるときは、この手順を飛ばします。質問が出たら Enter キーを押します。",
  "start.key.step2": "公開鍵をクラスタにコピーします。ssh がパスワードを聞いたら、パスワードを入力します。ログインノードは同じホームディレクトリを使うので、この手順は 1 回だけです。",
  "start.key.step3": "もう一度接続します。ssh がパスワードを聞かなければ、鍵は使えます。",

  "start.config.title": "ユーザー名を省略して接続",
  "start.config.lead": "次の行を `{path}` に追加します。ファイルがないときは作ります。その後は `ssh {alias}` で接続します。scp・rsync・VS Code もこの設定を使います。",
  "start.config.winNote": "ファイル名は `config` です。.txt を付けないでください。",

  "start.files.title": "ファイルのコピーとコードの編集",
  "start.files.lead": "これらのコマンドは手元の PC で実行します。ログインノードでは実行しません。コマンドは前の手順の設定を使います。",
  "start.files.up": "アップロード",
  "start.files.down": "ダウンロード",
  "start.files.folder": "フォルダをアップロード",
  "start.files.syncLabel": "フォルダを同期",
  "start.files.sync": "rsync は変更されたファイルだけをコピーします。コピーが止まったときは、同じコマンドをもう一度実行します。",
  "start.files.gui": "WinSCP・Cyberduck・FileZilla などの GUI ツールも使えます。同じホスト名・ユーザー名・鍵を使います。",
  "start.files.vscode": "VS Code でクラスタ上のファイルを編集するには、Remote - SSH 拡張をインストールします。次に `{alias}` に接続します。VS Code のターミナルもログインノードで動きます。計算には `salloc` か `sbatch` を使います。",

  "start.fromSlurm": "このクラスタをはじめて使うときは、まず「{siteName} 入門」を読んでください。ssh での接続方法と SSH 鍵の使い方を説明しています。",
};
