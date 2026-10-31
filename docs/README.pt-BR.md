# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · **Português** · [Italiano](README.it.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio é uma bancada modular de desenvolvimento embarcado: edição, compilação e gravação de firmware, comunicação serial, depuração de hardware, Git e colaboração. Use o aplicativo Electron ou um navegador conectado a um servidor Node.js no computador que possui os projetos e o hardware.

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## Recursos disponíveis

- Conclusão C/C++, definições, referências, diagnósticos e formatação via clangd, com índice do espaço de trabalho como alternativa; abas de visualização, edição dividida e recuperação de rascunhos.
- Compilação sem dispositivo conectado: entradas nomeadas, Debug/Release, otimização de tamanho e seleção separada de ferramentas C e C++.
- Exportação BIN, HEX, S-record e ELF, gravação de firmware pronto e compartilhamento de projetos com dependências externas de código.
- Pesquisa de bibliotecas Arduino, importação de pastas ou ZIPs de componentes e exportação de módulos e ferramentas para uso offline.
- Inspeção de registradores, desmontagem, pilha de chamadas e memória; execução passo a passo e inclusão de pontos de interrupção em lote.
- Abas, áreas de edição e logs recentes compartilhados; mesclagem de alterações independentes e preservação de conflitos. No navegador, desfazer afeta as próprias alterações.
- Gerenciamento gráfico de histórico Git, diferenças, preparação, commits, branches e remotos; vários terminais nativos e conexão com VS Code.
- Visualização de imagens e reprodução de áudio/vídeo; conclusão por IA opcional e edição limitada ao escopo escolhido. Módulos e extensões mantêm recursos e idiomas próprios.

## Escolha uma distribuição

| Edição           | Requisitos                   | Arquivo                                     |
| ---------------- | ---------------------------- | ------------------------------------------- |
| Desktop portátil | Windows x64; execução direta | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| Web independente | Windows x64; inclui Node.js  | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Web com Node.js  | Windows x64; Node.js 24+ x64 | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

As três edições compartilham formato de projeto e serviços. Extraia o ZIP Node.js e execute `start-web.cmd`; as dependências estão incluídas. O código em `main` pode ser mais recente que os pacotes: consulte as notas da versão baixada.

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## Hardware e sistemas

| Módulo de dispositivo            | Compilação                       | Conexão             |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

Os perfis atuais abrangem ESP32-S3 e STM32F103C8/C8T6. Os pinos da câmera são definidos no projeto. UART GDB do ESP32-S3 foi testado em uma configuração Windows de referência; a validação de USB-JTAG nativo continua. Windows x64 é a distribuição principal. As adaptações Linux x64/ARM64 e os caminhos de ferramentas macOS ainda não foram totalmente validados em máquinas reais.

## Primeiros passos

O desenvolvimento a partir do código requer Node.js 24+, npm e Git.

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

Para usar o navegador, execute os comandos no computador do projeto e do hardware e abra o link exibido. A seleção de pastas, compilação, USB, portas seriais e terminais é feita nesse servidor.

```sh
npm run web:build
npm run web:start
```

## Módulos e hosts binários

Os módulos separam dez responsabilidades: `support`, `device`, `runtime`, `constraints`, `ui`, `compiler`, `debugger`, `layout`, `languages` e `tools`. `be` armazena as entradas de compilação; `blode.components.json`, as bibliotecas. `package:runtime` gera JavaScript, manifestos e recursos independentes, carregados por hosts binários ou Web compatíveis sem o TypeScript do programa. Extensões gerais podem adicionar aparência, menus, janelas e painéis sem implementar compilação.

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## Assinaturas de pacotes

- `obe` é um manifesto JSON assinado com Ed25519 que vincula editor, ID/versão e caminho, tamanho e SHA-256 de cada arquivo. O conteúdo real é verificado novamente antes da instalação.
- A confiança oficial vem do registro de chaves públicas do host. Assinaturas ausentes ou desconhecidas, assinaturas inválidas e conteúdos alterados são diferenciados. A exportação preserva a assinatura existente sem tornar oficial um pacote de terceiros.
- As chaves privadas ficam em `.signing/`, fora do Git e dos pacotes. Windows Authenticode é uma camada separada; o certificado atual é autoassinado, não emitido por uma autoridade pública. Conteúdo assinado alterado exige nova assinatura.

[OBE / Authenticode](PACKAGE-SIGNING.md) · [Módulos e hosts binários](ENGINEERING.md)

## Trabalho em andamento

- Mais hardware, sessões longas de colaboração e migração de projetos entre computadores.
- Qualidade da IA, métodos de entrada e revisão da terminologia dos idiomas.
- Validação de instalação, ferramentas e USB em máquinas Linux/macOS.

## Documentação

- [Módulos e hosts binários](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [Assinaturas de pacotes](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## Licença e contribuições

O código é publicado sob Apache License 2.0. Compiladores, drivers e serviços de terceiros mantêm seus termos. Relate problemas e contribua pelo GitHub Issues e por Pull Requests.

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
