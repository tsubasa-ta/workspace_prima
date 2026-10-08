# Prima ワークスペース

LINE・Gmail・Googleカレンダーを常時表示し、右側の大きな作業スペースで何でも開ける 4ペインのデスクトップアプリです（Electron + Tailwind CSS）。

```
┌──────┬─────────────┐
│ LINE │             │
├──────┤             │
│Gmail │  作業スペース  │
├──────┤  （URL入力）  │
│ Cal  │             │
└──────┴─────────────┘
```

## 起動方法

1. [Node.js](https://nodejs.org/)（LTS版）をインストール
2. このフォルダでコマンドを実行

```bash
npm install   # 初回のみ
npm start
```

## 使い方

- **初回**：Gmail・カレンダーのペインでGoogleアカウントにログインします。ログイン状態は保存され、次回以降は不要です。
- **作業スペース**：上部のバーに URL か検索ワードを入れて Enter。★ で現在のページを「ホーム」に設定、↗ で通常のブラウザで開きます。
- **Gmail・カレンダーのリンク**：クリックすると右の作業スペースで開きます。⤢ ボタンでそのペインの画面を作業スペースに大きく表示できます。
- **サイズ変更**：ペインの間の境目をドラッグ。サイズは自動で保存されます。
- **未読バッジ**：Gmail の未読件数をペイン見出しに表示します。

## LINE（個人アカウント）の設定

個人のLINEにはWeb版がないため、**Chrome拡張版LINE** をこのアプリに読み込んで表示します。

1. Chrome で [LINE 拡張機能](https://chromewebstore.google.com/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc) をインストール
2. アプリの LINE ペインで「フォルダを選択」（または ⚙）を押し、次のフォルダ内の **バージョン番号のフォルダ**（`manifest.json` があるフォルダ）を選択
   - Windows: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\ophjlpahpchlmihnnnihgmmeilfjmjjc\`
   - Mac: `~/Library/Application Support/Google/Chrome/Default/Extensions/ophjlpahpchlmihnnnihgmmeilfjmjjc/`
3. LINE ペインにログイン画面（QRコード等）が表示されればOK

> **注意**：Electron の拡張機能対応は一部のみのため、LINE拡張のバージョンによっては正しく動作しない場合があります。その場合は「LINEアプリを起動」ボタンでPC版LINEを開いてください。Chrome拡張が更新されるとフォルダ名（バージョン）が変わるため、再度フォルダを選択してください。

## 開発

- `src/index.html` … 画面レイアウト（Tailwind のクラスで記述）
- `src/input.css` … Tailwind の入力（共通コンポーネントクラス）
- `src/renderer.js` … 画面の動作（アドレスバー、リサイズ、LINE読み込み）
- `main.js` / `preload.js` … Electron 本体・設定保存
- `npm run watch:css` で CSS を自動ビルドしながら編集できます
