# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio は、コード編集、ファームウェアのビルドと書き込み、シリアル通信、ハードウェアデバッグ、Git、共同作業を統合するモジュール型の組み込み開発環境です。Electron デスクトップアプリ、またはプロジェクトと機器を持つコンピューター上の Node.js ホストに接続するブラウザーで利用できます。

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## 利用できる機能

- clangd による C/C++ 補完、定義・参照、診断、整形。利用できない場合はワークスペース索引を使用します。プレビュータブ、分割編集、下書き復元にも対応します。
- 機器を接続せずにビルドできます。名前付きビルドエントリー、Debug／Release、サイズ最適化、C／C++ 別のツールチェーン選択を備えます。
- BIN、HEX、S-record、ELF の出力、用意済みファームウェアの書き込み、外部ソース依存関係を含むプロジェクト共有。
- Arduino ライブラリの検索、コンポーネントフォルダーや ZIP の読み込み、デバイスモジュールとツールチェーンのオフライン配布。
- レジスター、逆アセンブリ、コールスタック、メモリーの確認。接続したターゲットでステップ実行とブレークポイントの一括追加。
- タブ、編集範囲、最新ログを共有し、独立した変更を統合して競合を保持します。ブラウザーでの取り消しは自分の変更を対象とします。
- Git の履歴、差分、ステージング、コミット、ブランチ、リモートを GUI で管理。複数のネイティブ端末と VS Code 連携。
- 画像表示と音声・動画再生。任意で使える AI 補完と、指定範囲の質問・修正。デバイスモジュールと拡張機能は独自のリソースと言語カタログを管理します。

## 配布形式を選ぶ

| エディション             | 実行環境                            | ファイル                                    |
| ------------------------ | ----------------------------------- | ------------------------------------------- |
| ポータブルデスクトップ版 | Windows x64、直接起動               | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| スタンドアロン Web 版    | Windows x64、Node.js 同梱           | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Node.js 用 Web 版        | Windows x64、Node.js 24+ x64 が必要 | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

すべての形式でプロジェクト形式とホストサービスを共有します。Node.js ZIP を展開し、`start-web.cmd` を起動してください。依存パッケージは同梱されています。`main` のソースが配布版より新しい場合があります。配布版の機能はリリースノートを参照してください。

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## 対応ハードウェアとホスト

| デバイスモジュール               | ビルドツール                     | 接続                |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

現在のプロファイルは ESP32-S3 と STM32F103C8/C8T6 を対象とします。カメラのピンはプロジェクトで設定します。ESP32-S3 UART GDB は Windows の参照構成で検証済みで、ネイティブ USB-JTAG は検証を継続中です。主要配布環境は Windows x64 です。Linux x64/ARM64 の対応コードと macOS のカスタムツールパスは、実機検証が完了していません。

## クイックスタート

ソースからの開発には Node.js 24+、npm、Git が必要です。

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

ブラウザー版では、プロジェクトとハードウェアを持つコンピューターで次のコマンドを実行し、表示されたリンクを開きます。フォルダー選択、ビルド、USB、シリアルポート、端末はそのホストで処理されます。

```sh
npm run web:build
npm run web:start
```

## モジュール構造とバイナリホスト

デバイスモジュールは `support`、`device`、`runtime`、`constraints`、`ui`、`compiler`、`debugger`、`layout`、`languages`、`tools` の 10 分野に分離されています。`be` にビルド入力、`blode.components.json` にプロジェクトのライブラリを保存します。`package:runtime` は独立した JavaScript、マニフェスト、リソースを生成し、互換性のあるバイナリや Web ホストがホスト側の TypeScript ソースなしで読み込みます。汎用拡張はコンパイラーを実装せず、外観、メニュー、ウィンドウ、下部パネルを追加できます。

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## パッケージ署名

- `obe` は Ed25519 で署名した JSON マニフェストです。発行元、パッケージ ID・バージョン、各ファイルのパス・サイズ・SHA-256 を結び付け、インストール書き込み前に実際の内容を再検証します。
- 公式の信頼情報はホストの公開鍵レジストリから得ます。未署名・未知の発行元、署名破損、内容変更を区別します。エクスポートは元の署名を保持し、第三者パッケージに公式の身分を付与しません。
- 保守者の秘密鍵は `.signing/` に置き、Git や配布物に含めません。Windows Authenticode は別の層です。現在の証明書は自己署名で、公開 CA の証明書ではありません。署名済みの内容を変更したら再署名が必要です。

[OBE / Authenticode](PACKAGE-SIGNING.md) · [モジュール構造とバイナリホスト](ENGINEERING.md)

## 進行中の作業

- 対応機器の検証拡大、長時間の共同作業、コンピューター間のプロジェクト移行。
- AI 提案の品質、入力メソッド、各言語の専門用語の見直し。
- Linux／macOS 実機でのインストール、ツールチェーン、USB の検証。

## ドキュメント

- [モジュール構造とバイナリホスト](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [パッケージ署名](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## ライセンスと貢献

ソースは Apache License 2.0 で公開されています。第三者のコンパイラー、ドライバー、サービスにはそれぞれの条件が適用されます。不具合報告や改善は GitHub Issues と Pull Requests から受け付けます。

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
